const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../db');
const { requireAuth, requirePerm, can, requireProduct } = require('../middleware/auth');
const {
  requirementWhere, clientWhere, candidateWhere, matches, scopeOf, isAssignedTo, OUT_OF_SCOPE,
  teamRequirementWhere, UNASSIGNED_WHERE, isUnassigned, atsViewRole, clientPickerWhere, applicationWhere,
} = require('../utils/scope');
const { clientLevelFor } = require('../utils/clientRedact');
const { logAudit, logFieldChanges } = require('../utils/audit');
const { listWorkers } = require('../utils/workers');
const { notifyUsers } = require('../utils/notify');
const { teamLeadUserIdsFor } = require('../utils/positionScope');
const { MATCH_THRESHOLD, SUGGESTION_THRESHOLD, rankCandidates, computeMatch } = require('../utils/matching');
const bridge = require('../utils/jobPortalBridge');
// user notes #7 — post to every source / take down everywhere (utils/jobPosting.js)
const { autoPost, postingChannels } = require('../utils/jobPosting');
// user notes #6 — city-level location matching (utils/locationMatch.js)
const { citiesOf, valuesInCities } = require('../utils/locationMatch');
const {
  REQUIREMENT_STATUS_CODES, REQUIREMENT_LIVE_STATUSES, requirementIsLive,
  agreementIsActive, normalizeAgreementStatus, applicationIsOverdue, requirementStatusLabel, stageLabel,
  isPortalSource,
} = require('../utils/atsVocab');

const router = express.Router();

// POSTED EVERYWHERE, TAKEN DOWN EVERYWHERE (user notes #7). After a
// requirement is created, edited, bulk-changed or moves status, utils/
// jobPosting.js autoPost() publishes a LIVE requirement to every source (the
// TeamLink Job Portal, the careers page / website feed, the job-board feeds)
// and takes a Closed / On Hold / Draft one down from all of them, auditing
// each. The portal push runs in the background, so a slow portal never holds
// up the save; the requirement's "Posted on" panel shows Pending until it
// answers, then Posted or Failed with the reason. Never throws.
async function pushToPortal(r, ctx = {}) {
  if (!r) return null;
  return autoPost(r.id, {
    actorId: ctx.user ? ctx.user.id : null,
    actorName: ctx.user ? ctx.user.name : null,
    trigger: ctx.trigger || 'edit',
    prevStatus: ctx.prevStatus,
    background: true,
  }).catch(() => null);
}

router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'requirements', 'Requirement List', 'view'));

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const isClient = (user) => scopeOf(user).role === 'CLIENT';

// Scope is not decided here. utils/scope.js owns it, and the same rule drives
// the list query, the single-record check and the frontend's UI — so a record
// the user cannot reach is refused by the API, not merely hidden.
//
// The rule is the ASSIGNMENT CHAIN:
//   Requirement -> Assigned TL -> Assigned Recruiter(s) -> BDE -> Client
//
// One router.param covers EVERY /:id endpoint below — read and write alike —
// so no route can forget to scope-check.
router.param('id', async (req, res, next, id) => {
  const requirement = await prisma.requirement.findUnique({ where: { id } });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });
  if (!matches(requirement, requirementWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  req.requirement = requirement;
  return next();
});

// ---------------------------------------------------------------------------
// VIEW != EDIT. The six per-record permissions the brief names, resolved
// server-side against the ONE engine and then narrowed by the record itself.
//
//   VIEW    -> requirements/Requirement Detail/view   (+ data scope)
//   EDIT    -> requirements/Requirement Detail/edit
//   APPROVE -> requirements/Requirement Detail/approve  (activate / close)
//   ASSIGN  -> requirements/Requirement Detail/assign   (TL / recruiters / BDE)
//   SHARE   -> requirements/Job Posting/edit            (push the JD outward)
//   EXPORT  -> requirements/Requirement List/export
//
// A TL who can see a recruiter's requirement because it sits in their
// department does NOT thereby get to edit it: `edit` and `assign` additionally
// require that the user is named on the record's own assignment chain, unless
// they hold global scope.
// ---------------------------------------------------------------------------
async function requirementPermissions(user, record) {
  const [view, edit, approve, assign, share, exportable, pipeline, matching, pipelineEdit] = await Promise.all([
    can(user, 'ats', 'requirements', 'Requirement Detail', 'view'),
    can(user, 'ats', 'requirements', 'Requirement Detail', 'edit'),
    can(user, 'ats', 'requirements', 'Requirement Detail', 'approve'),
    can(user, 'ats', 'requirements', 'Requirement Detail', 'assign'),
    can(user, 'ats', 'requirements', 'Job Posting', 'edit'),
    can(user, 'ats', 'requirements', 'Requirement List', 'export'),
    can(user, 'ats', 'requirements', 'Requirement Pipeline', 'view'),
    can(user, 'ats', 'requirements', 'Matching Candidates', 'view'),
    // SEEING THE PIPELINE IS NOT ADDING TO IT. `pipeline` above is a VIEW
    // permission and the screen was drawing "Add to Pipeline" and the
    // "Move to…" control from it, so a view-only login (a Manager, §3) was
    // shown buttons whose POST the API refuses. This is the write half, and
    // it is the same permission routes/applications.js enforces.
    can(user, 'ats', 'candidates', 'Applications', 'create'),
  ]);
  const s = scopeOf(user);
  const owned = s.global || !record || isAssignedTo(user, record);
  const viewRole = atsViewRole(user);
  // A TL may assign a requirement nobody is on yet (role spec §1: the
  // department's unassigned openings are theirs to pick up) — the same
  // "unclaimed" rule POST /:id/assign and the bulk bar already apply.
  const unclaimed = !!record && isUnassigned(record);
  return {
    view,
    edit: edit && owned,
    approve: approve && owned,
    // Role spec §7: a BDE may Close (not Reopen / Hold / Delete).
    closeOnly: approve && owned && viewRole === 'bde',
    delete: s.global && await can(user, 'ats', 'requirements', 'Requirement Detail', 'delete'),
    assignUnclaimed: assign && unclaimed,
    assign: assign && owned,
    share: share && owned,
    export: exportable,
    pipeline,
    pipelineEdit,
    matching,
    // Why edit is off, so the screen can say so rather than just hiding a button.
    readOnlyReason: edit && !owned ? 'You can view this requirement, but it is not assigned to you.' : null,
  };
}

// A client sees its own requirement, never TeamLink's internals on it.
function shapeForClient(r) {
  const {
    recruiterId, bdeId, tlId, stlId, recruiterIds, recruiter, bde, accountManager,
    matchingCandidates, matchThreshold, postingSources, workedBy, workedByPosition, ...rest
  } = r;
  return rest;
}

// ---------------------------------------------------------------------------
// GET /requirements — the consistent filter set:
//   Department · Client · Location · Recruiter · TL · BDE · Status · Priority
//   · Date Range
// Every one of them is applied to the SCOPED query on the server, so a filter
// can only ever narrow what the user may already see.
// ---------------------------------------------------------------------------
// §13 / §14 — STATUS AND NEXT ACTION ARE DIFFERENT QUESTIONS.
//
// "Open" is what is happening now. It is NOT what to do about it, and using
// the status as the next action is why a requirement list reads like a
// database rather than a worklist. This answers the second question from the
// requirement's own state, most blocking first: no agreement stops everything,
// then nobody assigned, then no candidates, then whoever the pipeline is
// sitting on.
function requirementNextAction(r, counts) {
  // A CLOSED requirement asks nothing of anyone (review #2 §5: Closed -> No Action).
  if (r.status === 'CLOSED') return { nextAction: 'Closed — no action', owner: null, ownerRole: null };
  const agreementOk = !r.client || normalizeAgreementStatus(r.client.agreementStatus) === 'ACTIVE' || r.internal;
  if (!agreementOk) {
    return { nextAction: 'Complete the client agreement', owner: r.bde ? r.bde.name : (r.accountManager || null), ownerRole: 'BDE' };
  }
  if (!r.recruiterId) {
    return { nextAction: 'Assign a recruiter', owner: r.tlName || r.stlName || null, ownerRole: 'TL' };
  }
  if (!counts.total) {
    return { nextAction: 'Start sourcing candidates', owner: r.recruiter ? r.recruiter.name : null, ownerRole: 'Recruiter' };
  }
  if (counts.recruiterReview) {
    return { nextAction: `Review ${counts.recruiterReview} candidate(s)`, owner: r.recruiter ? r.recruiter.name : null, ownerRole: 'Recruiter' };
  }
  if (counts.tlReview) {
    return { nextAction: `TL review — ${counts.tlReview} candidate(s)`, owner: r.tlName || null, ownerRole: 'TL' };
  }
  if (counts.bde) {
    return { nextAction: `Share ${counts.bde} candidate(s) with the client`, owner: r.bde ? r.bde.name : null, ownerRole: 'BDE' };
  }
  if (counts.client) {
    return { nextAction: `Client decision pending — ${counts.client}`, owner: r.bde ? r.bde.name : null, ownerRole: 'BDE' };
  }
  if (counts.interview) {
    return { nextAction: `Interview in progress — ${counts.interview}`, owner: r.bde ? r.bde.name : null, ownerRole: 'BDE' };
  }
  if (counts.joining) {
    return { nextAction: `Confirm joining — ${counts.joining}`, owner: r.bde ? r.bde.name : null, ownerRole: 'BDE' };
  }
  if (r.remaining > 0) {
    return { nextAction: `Source for ${r.remaining} remaining opening(s)`, owner: r.recruiter ? r.recruiter.name : null, ownerRole: 'Recruiter' };
  }
  return { nextAction: 'All openings filled', owner: null, ownerRole: null };
}

// The same answer as a machine-readable KIND, so the list can make the Next
// Action a button that goes to the right place (§6 / §14) without parsing
// the sentence. Order matches requirementNextAction() above.
function nextActionKindOf(r, counts) {
  if (r.status === 'CLOSED') return 'done';
  const agreementOk = !r.client || normalizeAgreementStatus(r.client.agreementStatus) === 'ACTIVE' || r.internal;
  if (!agreementOk) return 'agreement';
  if (!r.recruiterId) return 'assign';
  if (!counts.total) return 'source';
  if (counts.recruiterReview) return 'review';
  if (counts.tlReview) return 'tl-review';
  if (counts.bde) return 'share';
  if (counts.client) return 'client';
  if (counts.interview) return 'interview';
  if (counts.joining) return 'joining';
  if (r.remaining > 0) return 'source';
  return 'done';
}

// ---------------------------------------------------------------------------
// §6 / §11 — the requirement's STAGE (where its hiring has got to) is not its
// STATUS (whether it is open at all). The stage is the furthest point any of
// its active candidates has reached, in the one workflow vocabulary:
//   New → AI Interview → Recruiter Review → TL Review → BDE Review
//     → Client Review → Interview → Selected → Offer → Joining
// ---------------------------------------------------------------------------
const STAGE_BUCKETS = [
  ['Joining', ['JOINED', 'HIRED']],
  ['Offer', ['OFFER', 'OFFER_ACCEPTED']],
  ['Selected', ['SELECTED']],
  ['Interview', ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED']],
  ['Client Review', ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED']],
  ['BDE Review', ['WITH_BDE', 'BDE_APPROVED']],
  ['TL Review', ['TL_REVIEW']],
  ['Recruiter Review', ['RECRUITER_REVIEW', 'RECRUITER_APPROVED']],
  ['AI Interview', ['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED']],
  ['New', ['NEW']],
];
// Waiting on a review decision — the TL's "Pending Review" column.
const PENDING_REVIEW_STAGES = ['NEW', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'TL_REVIEW'];
const INACTIVE_STAGES = ['REJECTED', 'HOLD'];

function requirementStage(r, stages) {
  if (r.status === 'DRAFT' || r.status === 'AGREEMENT_CHECK') return { stage: 'Not live', stageCount: 0 };
  for (const [label, codes] of STAGE_BUCKETS) {
    const n = stages.filter((s) => codes.includes(s)).length;
    if (n) return { stage: label, stageCount: n };
  }
  return { stage: requirementIsLive(r.status) ? 'Sourcing' : '—', stageCount: 0 };
}

// §6 / §28 — SLA of a requirement: how many of its candidates are past their
// stage SLA (the same applicationIsOverdue() the dashboard's Past SLA uses),
// and — for a live requirement with a target / closing date — how far that
// date is. `slaRank` is what the SLA sort orders by: most urgent first.
const DAY = 86400000;
function requirementSla(r, apps) {
  const overdue = apps.filter((a) => !INACTIVE_STAGES.includes(a.stage) && applicationIsOverdue(a)).length;
  const dueRaw = r.targetDate || r.closingDate || null;
  const due = dueRaw && !Number.isNaN(new Date(dueRaw).getTime()) ? String(dueRaw).slice(0, 10) : null;
  const live = requirementIsLive(r.status);
  const today = new Date(new Date().toISOString().slice(0, 10));
  const daysLeft = due && live ? Math.round((new Date(due) - today) / DAY) : null;
  let state = null;
  if (overdue || (daysLeft !== null && daysLeft < 0)) state = 'overdue';
  else if (daysLeft !== null && daysLeft <= 3) state = 'due-soon';
  else if (live) state = 'on-track';
  // Lower rank = more urgent. Overdue candidates dominate, then the date.
  const slaRank = (overdue ? -1e6 - overdue * 1000 : 0) + (daysLeft !== null ? daysLeft : 1e5);
  return { sla: { overdue, due, daysLeft, state }, slaRank };
}

// Section — the Education team (Team A / Team B) a requirement sits in, read
// from the seats (Position.team). "Team" alone (Medical, Manufacturing: one
// team) is not a section, so it reads "—".
function sectionOfCode(code, seatByCode) {
  const p = code ? seatByCode.get(code) : null;
  const team = p && p.team ? String(p.team).trim() : '';
  return team && team.toLowerCase() !== 'team' ? team : null;
}

const PRIORITY_RANK = { Urgent: 4, High: 3, Medium: 2, Low: 1 };
const LIST_SORTS = ['created', 'openings', 'candidates', 'sla', 'priority'];
// What a list row carries of its client and people — the names and the
// agreement gate, never the whole record (the client row carries the signing
// token and the full agreement text, the user row login internals).
const LIST_CLIENT_SELECT = {
  id: true, name: true, agreementStatus: true, agreementId: true, accountManager: true,
  ownerDepartment: true, clientType: true, bdeOwner: true,
  // Read so the commercial roles can be sent `commercial` (commercialOf);
  // clientForRole() never copies them onto the client object.
  agreementFeePercent: true, guaranteePeriod: true, paymentTerms: true, invoiceTrigger: true,
};
const PERSON_SELECT = { id: true, name: true, atsDepartment: true };

// CLIENT NAME ONLY OUTSIDE THE CLIENT DESK (binding rule: the Clients module
// is SA / Admin / Manager / Asst Manager / BDE). Everyone else working a
// requirement gets the client's name and the agreement gate's state — never
// the commercial record. Nobody, desk included, is sent the signing-link
// token or the OTP hash on a requirement payload.
const CLIENT_SECRETS = ['esignToken', 'agreementOtpHash', 'agreementOtpExpiresAt', 'agreementOtpAttempts'];
function clientForViewer(client, desk) {
  if (!client) return null;
  const agreementStatus = normalizeAgreementStatus(client.agreementStatus);
  if (!desk) return { id: client.id, name: client.name, agreementStatus, clientType: client.clientType || null };
  const out = { ...client, agreementStatus };
  CLIENT_SECRETS.forEach((k) => { delete out[k]; });
  return out;
}
const isClientDesk = (user) => can(user, 'ats', 'clients', 'Client List', 'view');

// ---------------------------------------------------------------------------
// JOBS / REQUIREMENTS ROLE SPEC (2026-09-29) — WHAT EACH ROLE IS SENT.
//
// One policy per login, from the permission engine (can()) and the ATS scope
// role (utils/scope.js atsViewRole), read by the list, the drawer summary and
// the detail page alike, so a column / section a role may not see is not in
// the RESPONSE either — hiding it on the screen is not the control.
//   §5  Recruiter never gets Fee / Agreement / commercial fields.
//   §7  sections:            Recruiter  TL     BDE   Accounts  Admin (Mgmt 👁)
//       JD / skills / …      ✅         ✅     ✅    👁        ✅
//       client contact       ❌         names  ✅    ❌        ✅
//       candidates pipeline  own        team   ✅    👁        ✅
//       fee / agreement      ❌         ❌     ✅    ✅        ✅
//       assign TL/recruiter  ❌         ✅     ✅    ❌        ✅
//       close/reopen/delete  ❌         ❌     close ❌        ✅
// ---------------------------------------------------------------------------
async function viewerPolicy(user) {
  const role = atsViewRole(user);
  const [commercial, agreementView, openClient, assign, approve, del, create, bulkImport, exportable, invoiceCreate] = await Promise.all([
    can(user, 'ats', 'clients', 'Commercial Terms', 'view'),
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'view'),
    can(user, 'ats', 'clients', 'Client Detail', 'view'),
    can(user, 'ats', 'requirements', 'Requirement Detail', 'assign'),
    can(user, 'ats', 'requirements', 'Requirement Detail', 'approve'),
    can(user, 'ats', 'requirements', 'Requirement Detail', 'delete'),
    can(user, 'ats', 'requirements', 'Create Requirement', 'create'),
    can(user, 'ats', 'requirements', 'Bulk Import', 'create'),
    can(user, 'ats', 'requirements', 'Requirement List', 'export'),
    can(user, 'accounts', 'accounts', 'Invoices', 'create'),
  ]);
  const level = clientLevelFor(user);
  return {
    role,
    level,
    invoiceCreate,
    commercial,
    agreementView,
    openClient,
    // Invoice amounts: Admin, Management, Accounts. A BDE sees the status only.
    invoiceAmounts: commercial && ['admin', 'mgmt', 'accounts'].includes(role),
    // §6 — the bulk checkbox is Admin, TL and BDE only.
    bulk: ['admin', 'tl', 'bde'].includes(role),
    buttons: { add: create, import: bulkImport, template: bulkImport, export: exportable },
    sections: {
      jd: role === 'accounts' || role === 'mgmt' ? 'view' : 'full',
      clientContact: role === 'accounts' ? null : (level === 'full' ? 'full' : level === 'names' ? 'names' : null),
      pipeline: role === 'recruiter' ? 'own' : role === 'tl' ? 'team' : ['accounts', 'mgmt'].includes(role) ? 'view' : 'all',
      commercial,
      assign,
      close: del ? 'all' : (approve && role === 'bde' ? 'close' : (approve ? 'all' : null)),
      delete: del,
    },
  };
}

// The client on a requirement payload, cut to what this role may see. The
// signing token / OTP hash are never selected at all.
function clientForRole(client, policy, { detail = false } = {}) {
  if (!client) return null;
  const out = {
    id: client.id,
    name: client.name,
    clientType: client.clientType || null,
    // The agreement GATE's state — it explains why a requirement is not live
    // (Agreement Pending); the agreement's terms are `commercial` below.
    agreementStatus: normalizeAgreementStatus(client.agreementStatus),
  };
  if (['full', 'billing', 'names'].includes(policy.level)) {
    ['ownerDepartment', 'bdeOwner', 'accountManager'].forEach((k) => { if (client[k] !== undefined) out[k] = client[k]; });
  }
  if (detail) {
    const contact = policy.sections.clientContact;
    if (contact) {
      ['legalName', 'clientCode', 'industry', 'location', 'status', 'priority', 'contactName', 'contactDesignation']
        .forEach((k) => { if (client[k] !== undefined) out[k] = client[k]; });
    }
    if (contact === 'full') {
      ['contactPhone', 'contactEmail'].forEach((k) => { if (client[k] !== undefined) out[k] = client[k]; });
    }
    if (policy.agreementView) {
      ['agreementId', 'agreementStart', 'agreementEnd', 'agreementActivatedAt']
        .forEach((k) => { if (client[k] !== undefined) out[k] = client[k]; });
    }
  }
  return out;
}

// Fee % / guarantee / payment terms — §5 / §6: BDE, Accounts, Admin, Mgmt.
function commercialOf(client, policy) {
  if (!policy.commercial || !client) return undefined;
  return {
    feePercent: client.agreementFeePercent ?? null,
    guaranteeDays: client.guaranteePeriod ?? null,
    paymentTerms: client.paymentTerms || null,
    invoiceTrigger: client.invoiceTrigger || null,
  };
}

// §5 Accounts "Invoice status" — one line per requirement from its invoices.
// Amounts only for Admin / Management / Accounts; a BDE gets the status.
function invoiceSummary(list, withAmounts) {
  if (!list || !list.length) return { status: 'Not invoiced', count: 0 };
  const st = list.map((i) => i.status);
  const status = st.every((s) => s === 'Paid') ? 'Paid'
    : st.some((s) => s === 'Overdue') ? 'Overdue'
      : st.some((s) => s === 'Partially Paid') ? 'Partially Paid' : 'Pending';
  const out = { status, count: list.length };
  if (withAmounts) {
    out.amount = list.reduce((n, i) => n + (Number(i.amount) || 0), 0);
    out.received = list.reduce((n, i) => n + (Number(i.receivedAmount) || 0), 0);
  }
  return out;
}

// §8.3 — THE MINI PIPELINE on every row: Screened → Submitted → Interview →
// Selected, counted over the applications THIS LOGIN may see (a recruiter
// their own, a TL their team's). Each count is "reached at least this step",
// from the candidate's current stage; Rejected / Hold are left out.
const MINI_STEP = {
  RECRUITER_REVIEW: 1, RECRUITER_APPROVED: 1, TL_REVIEW: 1, WITH_BDE: 1, BDE_APPROVED: 1,
  SHARED_WITH_CLIENT: 2, CLIENT_REVIEW: 2, CLIENT_SHORTLISTED: 2,
  INTERVIEW_SCHEDULED: 3, INTERVIEW_COMPLETED: 3,
  SELECTED: 4, OFFER: 4, OFFER_ACCEPTED: 4, JOINED: 4, HIRED: 4,
};
function miniPipeline(stages) {
  const at = stages.map((s) => MINI_STEP[s] || 0);
  return {
    screened: at.filter((n) => n >= 1).length,
    submitted: at.filter((n) => n >= 2).length,
    interview: at.filter((n) => n >= 3).length,
    selected: at.filter((n) => n >= 4).length,
  };
}

// §6 — the ONE main row action per role. `key` is what the screen wires up.
function primaryActionOf(row, policy) {
  switch (policy.role) {
    case 'recruiter': return row.live ? { key: 'add-candidate', label: 'Add Candidate' } : { key: 'view-candidates', label: 'View Candidates' };
    case 'tl': return row.mayAssign ? { key: 'assign-recruiter', label: 'Assign Recruiter' } : { key: 'open', label: 'View' };
    case 'bde':
      if (row.submitReady) return { key: 'submit-client', label: 'Submit to Client' };
      return row.mayEdit ? { key: 'edit', label: 'Edit' } : { key: 'open', label: 'View' };
    case 'accounts':
      return row.generateTo ? { key: 'generate-invoice', label: 'Generate Invoice', to: row.generateTo } : { key: 'open', label: 'View' };
    case 'admin': return { key: 'edit', label: 'Edit' };
    default: return { key: 'open', label: 'View' };
  }
}

// ---------------------------------------------------------------------------
// ATS review #2 §6 / §7 — THE PIPELINE COUNTS, ONE DEFINITION. The list row,
// the quick drawer and the detail page all read these from the same function,
// so the drawer can never say 5 Selected while the detail page says 4.
// Current-stage buckets (a candidate is counted once, where they are now):
//   candidates   every application on the requirement (incl. rejected / hold)
//   active       not Rejected / Hold
//   shortlisted  Client Shortlisted
//   interview    Interview Scheduled / Completed
//   selected     Selected / Offer / Offer Accepted (selected, not yet joined)
//   joined       Joined / Hired
// ---------------------------------------------------------------------------
const COUNT_BUCKETS = {
  shortlisted: ['CLIENT_SHORTLISTED'],
  interview: ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'],
  selected: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'],
  joined: ['JOINED', 'HIRED'],
};
// ATS review #3 §4 — THE REQUIREMENT 360 PIPELINE, seven steps in order:
//   New → Recruiter Review → TL Review → Client Review → Interview → Selected → Joined
// A candidate is counted once, at the step they are at now (Hold / Rejected
// are counted beside the steps, not in them). AI interview sits inside New
// (it happens before the recruiter's review); the BDE hand-off sits inside
// Client Review (it is the client-facing side). `stages` is what the
// Candidates page's ?stage= filter takes for that step.
const PIPELINE_STEPS = [
  { key: 'new', label: 'New', stages: ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'] },
  { key: 'recruiterReview', label: 'Recruiter Review', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  { key: 'tlReview', label: 'TL Review', stages: ['TL_REVIEW'] },
  { key: 'clientReview', label: 'Client Review', stages: ['WITH_BDE', 'BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'] },
  { key: 'interview', label: 'Interview', stages: ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'] },
  { key: 'selected', label: 'Selected', stages: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'] },
  { key: 'joined', label: 'Joined', stages: ['JOINED', 'HIRED'] },
];
// THE ACTUAL WORKFLOW (2026-09-29) — the Requirement 360 strip, per kind of
// requirement. A client requirement runs the client chain; an internal one
// (TeamLink's own opening) HR Review → Dept Head / TL → … → HRMS.
const CLIENT_WORKFLOW_STEPS = [
  { key: 'screening', label: 'Screening', stages: ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'] },
  { key: 'recruiterReview', label: 'Recruiter Review', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  { key: 'tlReview', label: 'TL Review', stages: ['TL_REVIEW'] },
  { key: 'bdeReview', label: 'BDE Review', stages: ['WITH_BDE', 'BDE_APPROVED'] },
  { key: 'clientSubmission', label: 'Client Submission', stages: ['SHARED_WITH_CLIENT'] },
  { key: 'clientDecision', label: 'Client Decision', stages: ['CLIENT_REVIEW', 'CLIENT_SHORTLISTED'] },
  { key: 'interview', label: 'Interview', stages: ['INTERVIEW_SCHEDULED'] },
  { key: 'feedback', label: 'Feedback', stages: ['INTERVIEW_COMPLETED'] },
  { key: 'selected', label: 'Selected', stages: ['SELECTED'] },
  { key: 'offer', label: 'Offer', stages: ['OFFER'] },
  { key: 'offerAccepted', label: 'Offer Accepted', stages: ['OFFER_ACCEPTED'] },
  { key: 'joined', label: 'Joining', stages: ['JOINED', 'HIRED'] },
];
const INTERNAL_WORKFLOW_STEPS = [
  { key: 'screening', label: 'Screening', stages: ['NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'] },
  { key: 'hrReview', label: 'HR Review', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  { key: 'deptHead', label: 'Dept Head / TL', stages: ['TL_REVIEW'] },
  { key: 'interview', label: 'Interview', stages: ['INTERVIEW_SCHEDULED'] },
  { key: 'feedback', label: 'Feedback', stages: ['INTERVIEW_COMPLETED'] },
  { key: 'selected', label: 'Selected', stages: ['SELECTED'] },
  { key: 'offer', label: 'Offer', stages: ['OFFER', 'OFFER_ACCEPTED'] },
  { key: 'joined', label: 'Joining', stages: ['JOINED'] },
  { key: 'hrms', label: 'HRMS', stages: ['HIRED'] },
];
function pipelineCounts(stages, { internal = false } = {}) {
  const out = {
    hiring: internal ? 'internal' : 'client',
    candidates: stages.length,
    active: stages.filter((s) => !['REJECTED', 'HOLD'].includes(s)).length,
    rejected: stages.filter((s) => s === 'REJECTED').length,
    hold: stages.filter((s) => s === 'HOLD').length,
  };
  Object.entries(COUNT_BUCKETS).forEach(([k, codes]) => { out[k] = stages.filter((s) => codes.includes(s)).length; });
  out.steps = (internal ? INTERNAL_WORKFLOW_STEPS : CLIENT_WORKFLOW_STEPS).map((st) => ({
    key: st.key, label: st.label, stages: st.stages, count: stages.filter((s) => st.stages.includes(s)).length,
  }));
  return out;
}

// Days since the requirement was raised — "Age: 18 days".
const ageDaysOf = (createdAt) => (createdAt ? Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000)) : null);

// §6 LAST ACTIVITY — the newest event on the requirement itself (audit rows:
// created, edited, assigned, status, postings) or on any of its applications
// (stage events: added, moved, rejected …), for a SET of requirements in two
// queries — never one query per row. The stage-event side uses a window
// function so a requirement with 900 applications still returns one row.
async function lastActivityFor(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const [audits, events] = await Promise.all([
    prisma.auditLog.findMany({
      where: { entity: { in: ['Requirement', 'RequirementPosting'] }, entityId: { in: ids } },
      select: { entityId: true, action: true, createdAt: true, actorName: true, user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.$queryRaw`SELECT rid, at, actor, action FROM (
      SELECT a.requirementId AS rid, e.createdAt AS at, e.actorName AS actor, e.action AS action,
        ROW_NUMBER() OVER (PARTITION BY a.requirementId ORDER BY e.createdAt DESC) AS rn
      FROM ApplicationStageEvent e JOIN Application a ON a.id = e.applicationId
      WHERE a.requirementId IN (${Prisma.join(ids)})) WHERE rn = 1`,
  ]);
  const put = (rid, at, by, what) => {
    const when = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(when.getTime())) return;
    const prev = out.get(rid);
    if (!prev || when > prev.at) out.set(rid, { at: when, by: by || 'System', what: what || null });
  };
  audits.forEach((a) => put(a.entityId, a.createdAt, (a.user && a.user.name) || a.actorName, a.action));
  (events || []).forEach((e) => put(e.rid, e.at, e.actor, e.action));
  return out;
}

// Every GET / filter, as one scoped where — shared by the paged list, the
// tab counts and the legacy full list.
async function listWhere(req) {
  const q = req.query;
  const where = { AND: [requirementWhere(req.user)] };
  const and = where.AND;

  if (q.department) and.push({ department: q.department });
  // ?type=client | internal — the Client | Internal split of the actual
  // workflow (internal hiring is not a separate module; it is this filter).
  if (q.type === 'internal') and.push({ internal: true });
  if (q.type === 'client') and.push({ internal: false });
  if (q.clientId) and.push({ clientId: q.clientId });
  if (q.location) and.push({ location: q.location });
  if (q.recruiterId) {
    and.push({ OR: [{ recruiterId: q.recruiterId }, { recruiterIds: { contains: q.recruiterId } }] });
  }
  if (q.tlId) and.push({ tlId: q.tlId });
  // BY THE PERSON WHO DID THE WORK, login or not. Imported tracker work is
  // attributed on the follow-ups (ownerName / tlName) — a recruiter who has
  // left, or never had a login, is found here and nowhere else.
  if (q.workedByName) {
    and.push({ OR: [
      { recruiter: { name: q.workedByName } },
      { applications: { some: { followUps: { some: { ownerName: q.workedByName } } } } },
    ] });
  }
  if (q.tlName) {
    and.push({ OR: [
      { tl: q.tlName },
      { applications: { some: { followUps: { some: { tlName: q.tlName } } } } },
    ] });
  }
  if (q.bdeId) and.push({ bdeId: q.bdeId });
  // A BDE without a login today, by the name their work is recorded under.
  if (q.bdeName) {
    and.push({ OR: [
      { bde: { name: q.bdeName } },
      { applications: { some: { followUps: { some: { bdeName: q.bdeName } } } } },
    ] });
  }
  // A SEAT (Position — MED-1, EDU-6 …): the requirements filed under it, plus
  // those carried by whoever sits in it now, since work follows the seat.
  // Several seats (a hierarchy Section, components/HierarchyFilter.jsx) come
  // comma-separated; each adds the same arms one seat always did.
  if (q.positionCode) {
    const arms = [];
    for (const code of String(q.positionCode).split(',').map((x) => x.trim()).filter(Boolean)) {
      // eslint-disable-next-line no-await-in-loop
      const holderUserId = await seatHolderUserId(code);
      arms.push({ positionCode: code });
      if (holderUserId) arms.push({ recruiterId: holderUserId }, { recruiterIds: { contains: holderUserId } }, { tlId: holderUserId });
    }
    and.push({ OR: arms.length ? arms : [{ positionCode: q.positionCode }] });
  }
  // One priority, or several comma-separated ("High,Urgent" — the High
  // Priority saved view).
  if (q.priority) {
    const list = csv(q.priority);
    and.push(list.length > 1 ? { priority: { in: list } } : { priority: list[0] || q.priority });
  }
  // A SET OF ROWS by id (the bulk bar's Export). Only ever narrows the scoped
  // where above — an id outside the caller's scope simply is not returned.
  if (q.ids) {
    const ids = csv(q.ids).slice(0, 1000);
    and.push({ id: { in: ids.length ? ids : ['__none__'] } });
  }
  // "MY" — the requirements this login is personally named on (TL, STL,
  // recruiter, co-recruiter or BDE), inside their scope. The "My Open
  // Requirements" / "My Overdue" saved views.
  if (q.mine === '1') and.push(mineWhere(req.user.id));
  // SAVED VIEWS (role spec 2026-09-29 §8.5): "Closing this week" — a live
  // requirement whose target / closing date falls in the next 7 days;
  // "No candidates yet" — not one application; ?unassigned=1 — nobody on it.
  if (q.closing === 'week') {
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    and.push({ status: { in: REQUIREMENT_LIVE_STATUSES } });
    and.push({ OR: [{ targetDate: { gte: today, lte: in7 } }, { closingDate: { gte: today, lte: in7 } }] });
  }
  if (q.nocand === '1') and.push({ applications: { none: {} } });
  if (q.unassigned === '1') and.push(UNASSIGNED_WHERE);
  // The screen's role chip (My Team / Unassigned / My Clients …) for an
  // export of exactly what the chip shows (routes/atsIo.js passes params).
  if (q.rview) {
    const def = roleViewDefs(req.user, q).views.find((v) => v.key === q.rview);
    if (def && def.where) and.push(def.where);
  }
  // The Agreement Pending tab as a filter — so an export of that tab
  // (routes/atsIo.js, which only knows all / open / closed) is that tab.
  if (q.agreement === 'pending') and.push(AGREEMENT_PENDING_WHERE);
  if (q.status === 'LIVE') and.push({ status: { in: REQUIREMENT_LIVE_STATUSES } });
  else if (q.status) and.push({ status: q.status });
  if (q.from) and.push({ createdAt: { gte: new Date(`${q.from}T00:00:00.000Z`) } });
  if (q.to) and.push({ createdAt: { lte: new Date(`${q.to}T23:59:59.999Z`) } });
  if (q.search) {
    and.push({ OR: [{ title: { contains: q.search } }, { skills: { contains: q.search } }, { reqCode: { contains: q.search } }] });
  }
  return where;
}

// ---------------------------------------------------------------------------
// THE CHIPS PER ROLE (role spec 2026-09-29 §1 default tab, §4 chips):
//   Recruiter  My Requirements (closed hidden) · Open  [+ Closed on request]
//   TL         My Team · Unassigned · Open · Closed
//   BDE        My Clients · Open · Closed   (+ Client / Internal filter)
//   Accounts   Joined / Billing
//   Admin/Mgmt All · Open · Closed · My Requirements · Unassigned (default Open)
//   STL / HR   All · Open · Closed · My Requirements
// Every chip only narrows the caller's scope (requirementWhere). The server
// picks the default when the screen asks for none.
// ---------------------------------------------------------------------------
const LIVE_WHERE = { status: { in: REQUIREMENT_LIVE_STATUSES } };
const NOT_LIVE_WHERE = { status: { notIn: REQUIREMENT_LIVE_STATUSES } };
function roleViewDefs(user, q = {}) {
  const role = atsViewRole(user);
  const me = user.id;
  const live = (r) => requirementIsLive(r.status);
  const team = teamRequirementWhere(user);
  const V = {
    all: { key: 'all', label: 'All', hint: 'Every requirement in your scope', where: null, test: () => true },
    open: { key: 'open', label: 'Open', hint: 'Live: Open, Recruiter Assigned, Sourcing, Candidates Available', where: LIVE_WHERE, test: live },
    closed: { key: 'closed', label: 'Closed', hint: 'Not live: Draft, Agreement Check, On Hold, Closed', where: NOT_LIVE_WHERE, test: (r) => !live(r) },
    mine: { key: 'mine', label: 'My Requirements', hint: 'Requirements you are named on — recruiter, co-recruiter, TL, STL or BDE', where: mineWhere(me), test: (r) => isMineRow(r, me) },
    unassigned: { key: 'unassigned', label: 'Unassigned', hint: 'Live requirements with no TL, no recruiter and no co-recruiter — assign them', where: { AND: [UNASSIGNED_WHERE, LIVE_WHERE] }, test: (r) => isUnassigned(r) && live(r) },
    team: { key: 'team', label: 'My Team', hint: "Requirements assigned to you and your team's recruiters", where: team, test: (r) => matches(r, team) },
    myclients: { key: 'myclients', label: 'My Clients', hint: 'Requirements of the clients you own', where: null, test: () => true },
    joined: { key: 'joined', label: 'Joined / Billing', hint: 'Requirements with joined candidates — the ones that bill', where: null, test: () => true },
    // Old links / saved views (?view=agreement) keep working; not a chip.
    agreement: { key: 'agreement', label: 'Agreement Pending', hint: '', where: null, test: () => true, hidden: true },
  };
  V.agreement.where = AGREEMENT_PENDING_WHERE;
  V.agreement.test = isAgreementPending;
  let keys;
  let def;
  switch (role) {
    case 'recruiter':
      V.mine = {
        ...V.mine,
        hint: 'Your requirements — closed ones are hidden (tick Show closed)',
        where: { status: { not: 'CLOSED' } },
        test: (r) => r.status !== 'CLOSED',
      };
      keys = ['mine', 'open', ...(q.showClosed === '1' ? ['closed'] : [])];
      def = 'mine';
      break;
    case 'tl': keys = ['team', 'unassigned', 'open', 'closed']; def = 'team'; break;
    case 'bde': keys = ['myclients', 'open', 'closed']; def = 'myclients'; break;
    case 'accounts': keys = ['joined']; def = 'joined'; break;
    case 'admin':
    case 'mgmt': keys = ['all', 'open', 'closed', 'mine', 'unassigned']; def = 'open'; break;
    default: keys = ['all', 'open', 'closed', 'mine']; def = 'all';
  }
  return {
    role,
    views: keys.map((k) => V[k]),
    byKey: V,
    defaultView: def,
    // §8.4 — "X requirements unassigned" for TL / Admin.
    alert: ['tl', 'admin'].includes(role),
  };
}

// "MY" as a where — the ?mine=1 filter and the My Requirements tab (review
// #3 §4) share it, so the tab count and the tab's rows can never disagree.
const mineWhere = (me) => ({ OR: [
  { recruiterId: me }, { recruiterIds: { contains: me } }, { tlId: me }, { stlId: me }, { bdeId: me },
] });
const isMineRow = (r, me) => [r.recruiterId, r.tlId, r.stlId, r.bdeId].includes(me) || csv(r.recruiterIds).includes(me);

// §2 — the AGREEMENT PENDING tab: held at Agreement Check, or a client
// requirement that is not closed while its client's agreement is not Active
// (the gate that stops it going live). Internal hiring has no agreement.
const AGREEMENT_PENDING_WHERE = {
  AND: [
    { status: { not: 'CLOSED' } },
    { OR: [
      { status: 'AGREEMENT_CHECK' },
      { internal: false, client: { agreementStatus: { not: 'ACTIVE' } } },
    ] },
  ],
};

// The same rule in JS, for a row already in memory.
const isAgreementPending = (r) => r.status === 'AGREEMENT_CHECK'
  || (r.status !== 'CLOSED' && !r.internal && !!r.client && r.client.agreementStatus !== 'ACTIVE');

// SLA = OVERDUE (the "My Overdue" view, ?sla=overdue). SLA is computed, not
// stored — the same requirementSla() the SLA column shows — so the filtered
// set is resolved in memory: one slim read of the (scoped, filtered)
// requirements and one flat read of their active applications. Not pushed
// back into SQL as an id list, which breaks SQLite's parameter limit once a
// scope holds thousands of overdue requirements.
async function overdueSlim(where) {
  const [slim, apps] = await Promise.all([
    prisma.requirement.findMany({
      where,
      select: {
        id: true, status: true, internal: true, priority: true, openings: true, createdAt: true,
        targetDate: true, closingDate: true, client: { select: { agreementStatus: true } },
        recruiterId: true, recruiterIds: true, tlId: true, stlId: true, bdeId: true, department: true, positionCode: true,
        _count: { select: { applications: true } },
      },
    }),
    prisma.application.findMany({
      where: { requirement: where, stage: { notIn: INACTIVE_STAGES } },
      select: { requirementId: true, stage: true, createdAt: true, updatedAt: true },
    }),
  ]);
  const byReq = new Map();
  apps.forEach((x) => { if (!byReq.has(x.requirementId)) byReq.set(x.requirementId, []); byReq.get(x.requirementId).push(x); });
  return slim
    .map((r) => ({ ...r, slaRank: requirementSla(r, byReq.get(r.id) || []).slaRank, overdue: requirementSla(r, byReq.get(r.id) || []).sla.state === 'overdue' }))
    .filter((r) => r.overdue);
}

// The list row: names on the chain, who works it and from which seat, the
// Section, Openings / Filled / Remaining, Candidates, Pending Review, Stage,
// SLA and Next Action. Built for exactly the rows asked for.
async function enrichRows(found, user, { activity = false } = {}) {
  // Resolve the assignment chain's names in one query rather than N.
  const people = await peopleFor(found);
  // The paged screen also gets Last Activity (two queries for the page) and a
  // per-row "may assign" flag for the drawer / bulk bar; the legacy full list
  // (export) does not pay for either.
  const [activityOf, assignPerm, editPerm, approvePerm] = activity
    ? await Promise.all([
      lastActivityFor(found.map((r) => r.id)),
      can(user, 'ats', 'requirements', 'Requirement Detail', 'assign'),
      can(user, 'ats', 'requirements', 'Requirement Detail', 'edit'),
      can(user, 'ats', 'requirements', 'Requirement Detail', 'approve'),
    ])
    : [new Map(), false, false, false];
  const sc = scopeOf(user);
  // WHO WORKS IT, AND FROM WHICH SEAT. A recruiter with a login is named on
  // the requirement; an imported tracker's recruiter often is not, and the
  // work is attributed on the follow-ups instead — so the latest follow-up's
  // owner and seat stand in, and the requirement's own seat code after that.
  const [seatOfUser, lastWork, seats] = await Promise.all([
    currentSeatsByUser([...found.map((r) => r.recruiterId), ...found.map((r) => r.tlId)]),
    found.length
      ? prisma.applicationFollowUp.findMany({
        where: { application: { requirementId: { in: found.map((r) => r.id) } }, ownerName: { not: null } },
        select: { ownerName: true, ownerPositionCode: true, application: { select: { requirementId: true } } },
        orderBy: { createdAt: 'desc' },
      })
      : [],
    prisma.position.findMany({ select: { code: true, team: true, department: true } }),
  ]);
  const seatByCode = new Map(seats.map((p) => [p.code, p]));
  const workOf = new Map();
  lastWork.forEach((f) => { if (!workOf.has(f.application.requirementId)) workOf.set(f.application.requirementId, f); });

  const forClient = isClient(user);
  const policy = await viewerPolicy(user);
  // The paged screen's per-row extras (role spec 2026-09-29): the SCOPED mini
  // pipeline, the invoice status (commercial roles) and whether the client
  // name may link to Client 360. Only for the page being drawn.
  const reqIds = activity ? found.map((r) => r.id) : [];
  const clientIds = [...new Set(found.map((r) => r.clientId).filter(Boolean))];
  const [scopedApps, invoiceRows, openable] = await Promise.all([
    reqIds.length && !['admin', 'mgmt'].includes(policy.role)
      ? prisma.application.findMany({ where: { AND: [applicationWhere(user), { requirementId: { in: reqIds } }] }, select: { requirementId: true, stage: true } })
      : null,
    reqIds.length && policy.commercial
      ? prisma.invoice.findMany({ where: { requirementId: { in: reqIds } }, select: { requirementId: true, status: true, amount: true, receivedAmount: true } })
      : [],
    activity && policy.openClient && clientIds.length
      ? prisma.client.findMany({ where: { AND: [clientWhere(user), { id: { in: clientIds } }] }, select: { id: true } })
      : [],
  ]);
  const scopedStages = new Map();
  (scopedApps || []).forEach((a) => {
    if (!scopedStages.has(a.requirementId)) scopedStages.set(a.requirementId, []);
    scopedStages.get(a.requirementId).push(a.stage);
  });
  const invoicesOf = new Map();
  invoiceRows.forEach((i) => { if (!invoicesOf.has(i.requirementId)) invoicesOf.set(i.requirementId, []); invoicesOf.get(i.requirementId).push(i); });
  const openableClients = new Set(openable.map((c) => c.id));
  return found.map((r) => {
    const apps = r.applications || [];
    const filled = apps.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length;
    const { applications, ...rest } = r;
    const workedByPosition = (r.recruiterId && seatOfUser.get(r.recruiterId)?.code)
      || workOf.get(r.id)?.ownerPositionCode || r.positionCode || null;
    const row = {
      ...rest,
      client: clientForRole(rest.client, policy),
      commercial: r.internal ? undefined : commercialOf(rest.client, policy),
      tlName: people.get(r.tlId) || r.tl || null,
      stlName: people.get(r.stlId) || r.stl || null,
      coRecruiterNames: csv(r.recruiterIds).map((id) => people.get(id)).filter(Boolean),
      workedBy: r.recruiter?.name || workOf.get(r.id)?.ownerName || null,
      workedByPosition,
      section: sectionOfCode(workedByPosition, seatByCode)
        || sectionOfCode(r.tlId && seatOfUser.get(r.tlId)?.code, seatByCode)
        || sectionOfCode(r.positionCode, seatByCode),
      filled,
      remaining: Math.max(0, (r.openings || 1) - filled),
      live: requirementIsLive(r.status),
    };
    // §13 / §14 — beside the status, never instead of it.
    const stages = apps.map((a) => a.stage);
    const has = (...list) => stages.filter((s) => list.includes(s)).length;
    const counts = {
      total: stages.length,
      recruiterReview: has('NEW', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'),
      tlReview: has('TL_REVIEW'),
      bde: has('WITH_BDE', 'BDE_APPROVED'),
      client: has('SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'),
      interview: has('INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'),
      joining: has('SELECTED', 'OFFER', 'OFFER_ACCEPTED'),
    };
    Object.assign(row, requirementNextAction(row, counts));
    row.nextActionKind = nextActionKindOf(row, counts);
    row.candidates = stages.length;
    row.activeCandidates = stages.filter((s) => !INACTIVE_STAGES.includes(s)).length;
    row.pendingReview = has(...PENDING_REVIEW_STAGES);
    Object.assign(row, requirementStage(row, stages.filter((s) => !INACTIVE_STAGES.includes(s))));
    row.sla = requirementSla(row, apps).sla;
    // §6 / §7 — Candidates / Shortlisted / Interview / Selected / Joined, Age.
    row.pipeline = pipelineCounts(stages, { internal: !!r.internal });
    row.ageDays = ageDaysOf(r.createdAt);
    row.agreementPending = r.status === 'AGREEMENT_CHECK'
      || (!r.internal && r.status !== 'CLOSED' && !!r.client && normalizeAgreementStatus(r.client.agreementStatus) !== 'ACTIVE');
    if (activity) {
      const la = activityOf.get(r.id);
      row.lastActivity = la ? { at: la.at, by: forClient ? null : la.by, what: la.what } : null;
      // The same rule POST /:id/assign enforces: global scope, named on the
      // chain, or a requirement nobody has claimed yet.
      const unclaimed = !r.tlId && !r.recruiterId && !r.recruiterIds;
      row.mayAssign = !!assignPerm && (sc.global || isAssignedTo(user, r) || unclaimed);
      // PUT /:id's rule (requirementPermissions().edit): edit + on the chain.
      row.mayEdit = !!editPerm && (sc.global || isAssignedTo(user, r));
      // POST /:id/status's rule (requirementPermissions().approve): Hold /
      // Close / Reopen from the row's "⋯" menu (review #3 §16).
      row.mayApprove = !!approvePerm && (sc.global || isAssignedTo(user, r));
      // "My Requirements" (§4): this login is named on the row's chain.
      row.mine = isMineRow(r, user.id);
      // ---- role spec 2026-09-29 --------------------------------------------
      // §8.3 mini pipeline, SCOPED: global roles see every candidate on it.
      const visibleStages = scopedApps ? (scopedStages.get(r.id) || []) : stages;
      row.pipelineMini = miniPipeline(visibleStages.filter((s) => !INACTIVE_STAGES.includes(s)));
      // §8.4 Unassigned = no TL, no recruiter, no co-recruiter.
      row.unassigned = isUnassigned(r);
      // §8.2 Days Open (live requirements only) and the 15+ days overdue flag.
      row.daysOpen = row.live ? row.ageDays : null;
      row.ageOverdue = row.live && row.ageDays !== null && row.ageDays >= 15;
      // The type at first glance (CLIENT / INTERNAL) and who it is with.
      row.type = r.internal ? 'INTERNAL' : 'CLIENT';
      row.organization = r.internal ? 'TeamLink' : (rest.client ? rest.client.name : null);
      row.assignedTo = r.recruiter ? r.recruiter.name : null;
      // Client 360 link: only for a role that may open Clients, and only a
      // client inside its Clients scope. Never for an internal requirement.
      row.clientLink = !r.internal && !!r.clientId && openableClients.has(r.clientId);
      if (policy.commercial && !r.internal) row.invoice = invoiceSummary(invoicesOf.get(r.id), policy.invoiceAmounts);
      // Accounts "Generate Invoice": a joined candidate not yet invoiced — the
      // same /invoices?join=<applicationId> flow the Accounts dashboard uses.
      if (policy.invoiceCreate && !r.internal) {
        const joinedApps = apps.filter((a) => ['JOINED', 'HIRED'].includes(a.stage));
        const invoiced = (invoicesOf.get(r.id) || []).length;
        if (joinedApps.length > invoiced && joinedApps[invoiced].id) row.generateTo = `/invoices?join=${joinedApps[invoiced].id}`;
      }
      // BDE "Submit to Client": TL-approved candidates are waiting with the BDE.
      row.submitReady = counts.bde > 0;
      row.mayDelete = !!policy.sections.delete;
      row.mayClose = row.mayApprove;
      row.primaryAction = primaryActionOf(row, policy);
    }
    return forClient ? shapeForClient(row) : row;
  });
}

// The include every list read uses. Applications carry only what Stage, SLA
// and the counts are computed from.
const LIST_INCLUDE = {
  client: { select: LIST_CLIENT_SELECT },
  recruiter: { select: PERSON_SELECT },
  bde: { select: PERSON_SELECT },
  applications: { select: { id: true, stage: true, createdAt: true, updatedAt: true } },
  _count: { select: { applications: true } },
};

// ---------------------------------------------------------------------------
// GET /requirements
//
// TWO SHAPES.
//   ?page=N        (the Jobs / Requirements screen) — SERVER-PAGINATED and
//                  server-SORTED: { rows, total, counts: {all, open, closed},
//                  page, pageSize, sort, dir, permissions }. `view` =
//                  all | open | closed narrows to the tab. Sorts (§28):
//                  created · openings · candidates · sla · priority.
//   no page        the legacy full array, still read by other screens and by
//                  the export (routes/atsIo.js). Same rows, slimmer: a list
//                  no longer ships every client's agreement text and signing
//                  token, which made this 21 MB and ten seconds for 4,347
//                  requirements.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const q = req.query;
  const where = await listWhere(req);
  const permissions = await requirementPermissions(req.user, null);

  if (q.page === undefined) {
    const found = await prisma.requirement.findMany({ where, include: LIST_INCLUDE, orderBy: { createdAt: 'desc' } });
    let requirements = await enrichRows(found, req.user);
    // ?sla=overdue — the same computed SLA the column shows (see overdueSlim).
    if (q.sla === 'overdue') requirements = requirements.filter((r) => r.sla && r.sla.state === 'overdue');
    return res.json(requirements.map((r) => ({ ...r, permissions })));
  }
  const overdueOnly = q.sla === 'overdue';

  // THE CHIPS FOR THIS ROLE (roleViewDefs) and their counts under the current
  // filters, plus the caller's whole scope (no filters) so every number can
  // say "of N total". No view asked for (first load) = the role's default.
  const defs = roleViewDefs(req.user, q);
  const viewDef = defs.views.find((v) => v.key === q.view)
    || (q.view === 'agreement' ? defs.byKey.agreement : null)
    || defs.views.find((v) => v.key === defs.defaultView);
  const view = viewDef.key;
  const scopeW = requirementWhere(req.user);
  const within = (w, arm) => (arm ? { AND: [w, arm] } : w);
  // ?sla=overdue: the filtered set is computed in memory (overdueSlim), and
  // the counts, the tab and the page are taken from it.
  const od = overdueOnly ? await overdueSlim(where) : null;
  const inView = viewDef.test;
  const countKeys = [...new Set([...defs.views.map((v) => v.key), view])];
  const countList = od
    ? countKeys.map((k) => od.filter((defs.byKey[k] || viewDef).test).length)
    : await Promise.all(countKeys.map((k) => prisma.requirement.count({ where: within(where, (defs.byKey[k] || viewDef).where) })));
  const counts = Object.fromEntries(countKeys.map((k, i) => [k, countList[i]]));
  const [scopeTotal, all, unassignedLive] = await Promise.all([
    prisma.requirement.count({ where: scopeW }),
    od ? od.length : prisma.requirement.count({ where }),
    // §8.4 — the top alert: live requirements in scope nobody is on.
    defs.alert ? prisma.requirement.count({ where: { AND: [scopeW, UNASSIGNED_WHERE, LIVE_WHERE] } }) : null,
  ]);
  const viewWhere = within(where, viewDef.where);
  const total = counts[view];

  const pageSize = Math.min(200, Math.max(5, Number(q.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
  const sort = LIST_SORTS.includes(q.sort) ? q.sort : 'created';
  const dir = q.dir === 'asc' ? 'asc' : 'desc';
  const skip = (page - 1) * pageSize;

  let ids;
  if (od) {
    const sign = dir === 'asc' ? 1 : -1;
    const keyOf = {
      created: (r) => new Date(r.createdAt).getTime(),
      openings: (r) => r.openings || 0,
      candidates: (r) => (r._count ? r._count.applications : 0),
      priority: (r) => PRIORITY_RANK[r.priority] || 0,
      sla: (r) => -r.slaRank,
    }[sort];
    ids = od.filter(inView)
      .sort((a, b) => sign * (keyOf(a) - keyOf(b)) || (b.createdAt - a.createdAt))
      .slice(skip, skip + pageSize).map((r) => r.id);
  } else if (sort === 'created' || sort === 'openings' || sort === 'candidates') {
    const orderBy = sort === 'created' ? [{ createdAt: dir }]
      : sort === 'openings' ? [{ openings: dir }, { createdAt: 'desc' }]
        : [{ applications: { _count: dir } }, { createdAt: 'desc' }];
    ids = (await prisma.requirement.findMany({ where: viewWhere, select: { id: true }, orderBy, skip, take: pageSize }))
      .map((r) => r.id);
  } else {
    // Priority and SLA are computed, not stored columns — rank the (already
    // scoped and filtered) set on the server, then page it.
    const slim = await prisma.requirement.findMany({
      where: viewWhere,
      select: {
        id: true, priority: true, createdAt: true, status: true, targetDate: true, closingDate: true,
      },
    });
    if (sort === 'sla') {
      // One flat read of the applications' stage + dates, grouped here — a
      // nested include over thousands of requirements is several times slower.
      const apps = await prisma.application.findMany({
        where: { requirement: viewWhere },
        select: { requirementId: true, stage: true, createdAt: true, updatedAt: true },
      });
      const byReq = new Map();
      apps.forEach((a) => { if (!byReq.has(a.requirementId)) byReq.set(a.requirementId, []); byReq.get(a.requirementId).push(a); });
      slim.forEach((r) => { r.applications = byReq.get(r.id) || []; });
    }
    const key = sort === 'priority'
      ? (r) => PRIORITY_RANK[r.priority] || 0
      : (r) => -requirementSla(r, r.applications || []).slaRank; // higher = more urgent
    const sign = dir === 'asc' ? 1 : -1;
    const rank = new Map(slim.map((r) => [r.id, key(r)]));
    slim.sort((a, b) => sign * (rank.get(a.id) - rank.get(b.id)) || (b.createdAt - a.createdAt));
    ids = slim.slice(skip, skip + pageSize).map((r) => r.id);
  }

  const found = ids.length
    ? await prisma.requirement.findMany({ where: { id: { in: ids } }, include: LIST_INCLUDE })
    : [];
  const order = new Map(ids.map((id, i) => [id, i]));
  found.sort((a, b) => order.get(a.id) - order.get(b.id));
  const rows = await enrichRows(found, req.user, { activity: true });
  const policy = await viewerPolicy(req.user);
  return res.json({
    rows, total, page, pageSize, pages, sort, dir, view,
    counts: { ...counts, filtered: all, scopeTotal },
    // The screen draws exactly these chips, in this order (role spec §4).
    views: defs.views.map((v) => ({ key: v.key, label: v.label, hint: v.hint })),
    defaultView: defs.defaultView,
    viewRole: policy.role,
    alert: defs.alert ? { unassigned: unassignedLive } : null,
    permissions: {
      ...permissions,
      bulk: policy.bulk,
      buttons: policy.buttons,
      commercial: policy.commercial,
      openClient: policy.openClient,
    },
  });
});

// THE MATCH COUNT IS NOT COMPUTED IN THE LIST. See /match-counts below.
//
// The list used to load every candidate and call rankCandidates() once per
// requirement — fine against the demo data's 16 requirements and 24
// candidates (384 comparisons), and fatal against the real data's 2,018 and
// 6,312: TWELVE AND A HALF MILLION skill comparisons on every single request
// for the list. The endpoint stopped answering at all, which is how it was
// found. The screen only ever shows a page of rows, so it asks for the counts
// of the rows it is actually drawing.

// Match counts for a NAMED SET of requirements — the ones on screen.
//
// 25 requirements against 6,312 candidates is ~158,000 comparisons and returns
// in well under a second; the whole list was 12.5 million and never returned.
// The cap is what keeps that true: ask for 200 and you get 200, ask for
// everything and you get told no, rather than quietly bringing the API down
// again.
const MATCH_COUNT_LIMIT = 200;
router.get('/match-counts', async (req, res) => {
  const permissions = await requirementPermissions(req.user, null);
  if (!permissions.matching) return res.json({});

  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return res.json({});
  if (ids.length > MATCH_COUNT_LIMIT) {
    return res.status(400).json({ error: `Ask for at most ${MATCH_COUNT_LIMIT} requirements at a time.` });
  }

  // Scoped like every other read: ids you may not see return nothing rather
  // than an error, so a guessed id leaks neither a count nor its existence.
  const rows = await prisma.requirement.findMany({
    where: { AND: [requirementWhere(req.user), { id: { in: ids } }] },
  });
  if (!rows.length) return res.json({});

  const candidates = await prisma.candidate.findMany({ select: MATCH_CANDIDATE_SELECT });
  const out = {};
  rows.forEach((r) => { out[r.id] = rankCandidates(candidates, r).length; });
  return res.json(out);
});

// One lookup for every user id named anywhere on the assignment chain.
async function peopleFor(rows) {
  const ids = new Set();
  rows.forEach((r) => {
    [r.tlId, r.stlId].forEach((id) => id && ids.add(id));
    csv(r.recruiterIds).forEach((id) => ids.add(id));
  });
  if (!ids.size) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

// The people who may be put on a requirement — the Assignment picker's source.
//
// It carried NO permission guard, so a CLIENT login received the full internal
// staff directory: every recruiter, TL, STL and BDE in the company, by name.
// It is now held to the same feature that opens the Recruiter & BDE screen —
// an ATS working role — which excludes clients, candidates, accountants and
// HRMS-only employees by construction rather than by a role string.
//
// Scoped: a TL only assigns within the departments they actually cover.
// WHO THIS LOGIN MAY PUT ON A REQUIREMENT — the assignment picker's bench
// (GET /assignable-people) and the bulk Assign Recruiter / Assign TL check
// (POST /bulk), from one where so the two can never disagree.
async function assignableWhere(user) {
  const s = scopeOf(user);
  const where = {
    atsAccess: true,
    status: 'Active',
    atsRole: { in: ['RECRUITER', 'TL', 'STL', 'BDE'] },
    // NEVER A TEST LOGIN (the user's rule, 2026-09-29): temporary ZZTEST /
    // example.test users must not be offered as — or accepted as — an
    // assignee. SQLite LIKE is case-insensitive for ASCII.
    NOT: [{ name: { contains: 'zztest' } }, { email: { contains: 'example.test' } }],
  };
  if (!s.global) {
    // THE BDE BENCH IS NOT COMPANY-WIDE EITHER. This used to carry an
    // unconditional `{ atsRole: 'BDE' }` arm on the grounds that a BDE works
    // across desks — true of the ROLE, but not of any particular BDE. The
    // effect was that a Medical TL was offered Nandita Rao and Sanjay Mehta,
    // who between them own Vertex, Nalanda and Orbit and not one Medical
    // client: "medical tl ki BDE endhuku kanipistharu?"
    //
    // A BDE belongs on this list when they actually meet this caller's work —
    // assigned to a client in scope, or already named on a requirement in
    // scope. Both sides are computed from the same utils/scope.js helpers the
    // lists themselves use, so the dropdown cannot offer somebody the caller
    // could not otherwise see.
    const [scopedClients, scopedReqs] = await Promise.all([
      prisma.client.findMany({ where: clientWhere(user), select: { id: true } }),
      prisma.requirement.findMany({ where: requirementWhere(user), select: { bdeId: true } }),
    ]);
    const clientIds = scopedClients.map((c) => c.id);
    const namedBdeIds = [...new Set(scopedReqs.map((r) => r.bdeId).filter(Boolean))];
    const bdeArms = [];
    if (clientIds.length) {
      // atsScopeClients is a COMMA-SEPARATED column, so it is matched with a
      // `contains` per id, the same way atsScopeDepartments is below.
      bdeArms.push({ atsRole: 'BDE', OR: clientIds.map((id) => ({ atsScopeClients: { contains: id } })) });
    }
    if (namedBdeIds.length) bdeArms.push({ atsRole: 'BDE', id: { in: namedBdeIds } });

    // `atsScopeDepartments` is a COMMA-SEPARATED column, so `{ in: [...] }`
    // only ever matched a single-department list. `contains` per department is
    // what actually finds an STL scoped to "Medical,IT".
    const team = [...(s.teamUserIds || []), ...((s.positions && s.positions.holderUserIds) || [])];
    // THE BENCH FOLLOWS THE SCOPE (review #3 §2 access audit): a TL with a
    // team assigns inside THAT team, not the whole department (Section A's TL
    // was offered Section B's TL and recruiters); a Recruiter / BDE / HR — who
    // hold no assign permission — see only themselves and the BDEs they meet.
    // STL / Manager / Asst Manager keep their departments.
    const deptBench = ['STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.atsRole)
      || (s.atsRole === 'TL' && !team.length);
    where.OR = s.departments.length && deptBench
      ? [
        { atsDepartment: { in: s.departments } },
        ...s.departments.map((d) => ({ atsScopeDepartments: { contains: d } })),
        ...bdeArms,
      ]
      : [{ id: s.userId }, ...bdeArms];
    if (team.length && ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.atsRole)) where.OR.push({ id: { in: team } });
  }
  return where;
}

router.get('/assignable-people', requirePerm('ats', 'recruiterbde', 'Team View', 'view'), async (req, res) => {
  const where = await assignableWhere(req.user);
  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, atsRole: true, atsDepartment: true, team: true },
    orderBy: { name: 'asc' },
  });
  // Each person's CURRENT seat, so picking a recruiter can fill in their seat.
  const seatOf = await currentSeatsByUser(users.map((u) => u.id));
  res.json(users.map((u) => ({ ...u, seat: seatOf.get(u.id) || null })));
});

// ---------------------------------------------------------------------------
// POST /requirements/bulk — the "N selected" bar (ATS review #2 §21).
//   { action: 'assign-recruiter', ids: [...], userId }   Requirement Detail / assign
//   { action: 'assign-tl',        ids: [...], userId }   Requirement Detail / assign
//   { action: 'priority',         ids: [...], priority } Requirement Detail / approve
// (Export is the ordinary export — POST /ats-io/export/requirements with the
// selected ids — which checks the export permission and scope itself.)
//
// NO SECOND RULE SET. The permission is checked once up front (a login that
// may not do this at all — a Recruiter, a view-only Manager — is refused with
// 403, not handed N failures), then EVERY ROW on its own against the same
// rules as the single-record endpoints: in the caller's scope (router.param's
// check), and — like POST /:id/assign — named on the record's chain, global,
// or an unclaimed requirement. The person assigned must be on the caller's own
// assignment bench (assignableWhere). One row's refusal never blocks the
// others and never passes silently: every row is reported.
// ---------------------------------------------------------------------------
const BULK_LIMIT = 200;
const BULK_ACTIONS = { 'assign-recruiter': 'assign', 'assign-tl': 'assign', priority: 'approve' };
router.post('/bulk', async (req, res, next) => {
  try {
    const user = req.user;
    const b = req.body || {};
    const action = String(b.action || '');
    const perm = BULK_ACTIONS[action];
    if (!perm) return res.status(400).json({ error: 'action must be assign-recruiter, assign-tl or priority' });
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one requirement.' });
    if (ids.length > BULK_LIMIT) return res.status(400).json({ error: `At most ${BULK_LIMIT} requirements per request.` });
    if (isClient(user) || !(await can(user, 'ats', 'requirements', 'Requirement Detail', perm))) {
      const what = perm === 'assign' ? 'Assigning requirements' : 'Changing requirement priority';
      return res.status(403).json({ error: `${what} isn't included in your role's permissions.` });
    }

    let target = null;
    let priority = null;
    if (action === 'priority') {
      priority = String(b.priority || '') === 'Critical' ? 'Urgent' : String(b.priority || '');
      if (!PRIORITY_VALUES.includes(priority)) return res.status(400).json({ error: 'Choose a priority: Critical, High, Medium or Low.' });
    } else {
      const wantRole = action === 'assign-tl' ? 'TL' : 'RECRUITER';
      target = b.userId ? await prisma.user.findFirst({
        where: { AND: [await assignableWhere(user), { id: String(b.userId) }, { atsRole: wantRole }] },
        select: { id: true, name: true },
      }) : null;
      if (!target) {
        return res.status(400).json({
          error: `Choose an active ${wantRole === 'TL' ? 'TL' : 'recruiter'} from your own team — that person is not on your assignment list.`,
        });
      }
    }

    const s = scopeOf(user);
    const scopeW = requirementWhere(user);
    const found = await prisma.requirement.findMany({ where: { id: { in: ids } } });
    const byId = new Map(found.map((r) => [r.id, r]));
    const results = [];
    for (const id of ids) {
      const r = byId.get(id);
      const base = { id, reqCode: r ? r.reqCode : null, title: r ? r.title : null };
      if (!r) { results.push({ ...base, ok: false, error: 'Requirement not found' }); continue; }
      if (!matches(r, scopeW)) { results.push({ ...base, ok: false, error: 'Outside your access' }); continue; }
      const unclaimed = !r.tlId && !r.recruiterId && !r.recruiterIds;
      const owned = s.global || isAssignedTo(user, r) || (perm === 'assign' && unclaimed);
      if (!owned) {
        results.push({ ...base, ok: false, error: 'You can view this requirement, but it is not assigned to you — ask its TL or an Admin.' });
        continue;
      }

      if (action === 'priority') {
        if (r.priority === priority) { results.push({ ...base, ok: false, skipped: true, error: `Already ${priority === 'Urgent' ? 'Critical' : priority}` }); continue; }
        // eslint-disable-next-line no-await-in-loop
        const updated = await prisma.requirement.update({ where: { id: r.id }, data: { priority } });
        // eslint-disable-next-line no-await-in-loop
        await logFieldChanges({
          userId: user.id, actorName: user.name, entity: 'Requirement', entityId: r.id, action: 'Requirement field changed',
          changes: [{ field: 'priority', label: FIELD_LABELS.priority, from: r.priority, to: priority }],
          approvalStatus: null, reason: b.reason || 'Bulk change',
        });
        // eslint-disable-next-line no-await-in-loop
        await pushToPortal(updated, { user, trigger: 'edit' });
        results.push({ ...base, ok: true, from: r.priority, to: priority });
        continue;
      }

      const field = action === 'assign-tl' ? 'tlId' : 'recruiterId';
      if (r[field] === target.id) { results.push({ ...base, ok: false, skipped: true, error: `Already with ${target.name}` }); continue; }
      const data = { [field]: target.id };
      if (action === 'assign-tl') data.tl = target.name;
      else {
        // eslint-disable-next-line no-await-in-loop
        const seat = await seatOfRecruiter(target.id);
        if (seat) { data.positionId = seat.id; data.positionCode = seat.code; }
        if (r.status === 'OPEN') data.status = 'RECRUITER_ASSIGNED';
      }
      // eslint-disable-next-line no-await-in-loop
      const updated = await prisma.requirement.update({ where: { id: r.id }, data });
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: user.id,
        actorName: user.name,
        action: 'Requirement assignment changed',
        entity: 'Requirement',
        entityId: r.id,
        fromValue: [r.tlId, r.recruiterId, r.bdeId].filter(Boolean).join(' / ') || 'unassigned',
        toValue: [updated.tlId, updated.recruiterId, updated.bdeId].filter(Boolean).join(' / ') || 'unassigned',
        reason: `Bulk ${action === 'assign-tl' ? 'Assign TL' : 'Assign Recruiter'}: ${target.name}`,
      });
      // eslint-disable-next-line no-await-in-loop
      await notifyAssignment(updated, user.id);
      // eslint-disable-next-line no-await-in-loop
      await pushToPortal(updated, { user, trigger: 'status', prevStatus: r.status });
      results.push({ ...base, ok: true, to: target.name });
    }
    return res.json({
      action,
      results,
      done: results.filter((x) => x.ok).length,
      skipped: results.filter((x) => x.skipped).length,
      failed: results.filter((x) => !x.ok && !x.skipped).length,
    });
  } catch (err) {
    return next(err);
  }
});

// The seats (Positions) the Requirements filters offer — code, name,
// department and who sits in each now. Read-only; a seat list says nothing a
// requirement list does not already imply.
// CLIENT NAMES FOR PICKING, NOT CLIENT RECORDS. Clients and their details are
// the client desk's (permissions SET.CLIENT_DESK); a TL raising a requirement
// or a recruiter filtering by client still needs the names. This returns only
// what a picker needs — id, name, owning department and whether the agreement
// is live (the form's agreement gate) — scoped exactly like the client list.
router.get('/client-options', async (req, res) => {
  const rows = await prisma.client.findMany({
    where: clientPickerWhere(req.user), // names only; a TL keeps the department directory to raise a requirement
    select: { id: true, name: true, ownerDepartment: true, agreementStatus: true },
    orderBy: { name: 'asc' },
  });
  res.json(rows.map((c) => ({ ...c, agreementStatus: normalizeAgreementStatus(c.agreementStatus) })));
});

// EVERYONE WHO WORKED THE REQUIREMENTS THIS CALLER CAN SEE — current and
// former — for the Recruiter and TL filters. The login-based lists only know
// people who can sign in today; a recruiter who has left, whose work came in
// with the Medical tracker, exists only as a name on the follow-ups. Each
// name carries the seats they held and whether they are still here, so the
// filter can say "Nandam Kaveri · MED-1 · left Jan 2026".
// Scoped: nobody learns names from outside their scope.
//
// The list is built ONCE, in utils/workers.js, and also served in full as
// GET /api/ats/workers (every ATS screen's person filters). This keeps the
// older shape for anything still reading it.
router.get('/workers', async (req, res) => {
  const w = await listWorkers(req.user);
  const shape = (x) => ({
    name: x.name, value: x.value, userId: x.userId, count: x.count, department: x.department,
    departments: x.departments, left: !x.current, seat: x.seat, from: x.from, to: x.to, current: x.current,
  });
  res.json({ recruiters: w.recruiters.map(shape), tls: w.tls.map(shape), bdes: w.bdes.map(shape) });
});

router.get('/seats', async (req, res) => {
  // SCOPED (review #3 §2 access audit): the company-wide seat directory, with
  // every holder's name, went to every ATS login. Now: global -> all seats; a
  // seat holder -> the seats in their structure (a TL their team, a recruiter
  // their own); an STL without a seat -> their departments; anyone else -> none.
  const s = scopeOf(req.user);
  let seatWhere = { active: true };
  if (!s.global) {
    const codes = s.positions ? s.positions.positionCodes : [];
    const depts = s.atsRole === 'STL' ? s.departments : [];
    seatWhere = { active: true, OR: [{ code: { in: codes } }, ...(depts.length ? [{ department: { in: depts } }] : [])] };
  }
  const positions = await prisma.position.findMany({
    where: seatWhere, select: { id: true, code: true, name: true, department: true },
    orderBy: [{ department: 'asc' }, { code: 'asc' }],
  });
  const holders = await prisma.positionAssignment.findMany({
    where: { positionId: { in: positions.map((p) => p.id) }, toDate: null },
    include: { employee: { select: { name: true, userId: true } } },
  });
  const byPosition = new Map(holders.map((h) => [h.positionId, h.employee]));
  res.json(positions.map((p) => ({
    code: p.code, name: p.name, department: p.department,
    holderName: byPosition.get(p.id)?.name || null,
    holderUserId: byPosition.get(p.id)?.userId || null,
  })));
});

// userId → { code, name, department } of the seat they hold today.
async function currentSeatsByUser(userIds) {
  const ids = userIds.filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await prisma.positionAssignment.findMany({
    where: { toDate: null, employee: { userId: { in: ids } } },
    include: { position: { select: { code: true, name: true, department: true } }, employee: { select: { userId: true } } },
  });
  return new Map(rows.map((r) => [r.employee.userId, r.position]));
}

async function seatHolderUserId(code) {
  const row = await prisma.positionAssignment.findFirst({
    where: { toDate: null, position: { code } },
    include: { employee: { select: { userId: true } } },
  });
  return row?.employee?.userId || null;
}

// What the detail page needs of each application — NOT the whole candidate
// record. It used to include every candidate column for every application and
// then load the ENTIRE candidate master (16,900 rows) to count matches, which
// is why the page took ~7 seconds. Matching is now its own lazy call
// (GET /:id/matching-candidates, only when the Candidates tab asks).
const MATCH_CANDIDATE_SELECT = {
  id: true, name: true, location: true, preferredLocation: true, experienceYears: true, relevantExperienceYears: true,
  skills: true, education: true, availability: true, currentSalary: true, expectedSalary: true, jobPreference: true,
  noticePeriod: true, preferredEmploymentType: true, preferredWorkMode: true,
};
const DETAIL_CLIENT_SELECT = {
  id: true, name: true, legalName: true, clientCode: true, industry: true, location: true, clientType: true,
  ownerDepartment: true, status: true, priority: true, contactName: true, contactDesignation: true,
  contactPhone: true, contactEmail: true, accountManager: true, bdeOwner: true, paymentTerms: true,
  agreementId: true, agreementStatus: true, agreementStart: true, agreementEnd: true, agreementActivatedAt: true,
  agreementDocument: true, agreementFeePercent: true, guaranteePeriod: true, invoiceTrigger: true,
};
const DETAIL_APP_SELECT = {
  id: true, candidateId: true, stage: true, createdAt: true, updatedAt: true,
  matchScore: true, resumeScore: true, source: true, firstSource: true,
  interviewAt: true, interviewStatus: true, interviewType: true, interviewRound: true, interviewMode: true,
  interviewer: true, interviewResult: true, interviewCode: true,
  aiInterviewStatus: true, aiInterviewScore: true,
  offerStatus: true, joiningStatus: true, joiningDate: true, joinedAt: true,
  candidate: { select: { id: true, name: true, location: true, experienceYears: true } },
};

// Review #3 §4 — the Job Portal line of the Requirement 360: published or
// not, since when, how many applications came in through the portal
// (Application.source / firstSource naming a portal — the rule
// routes/jobPortal.js uses), and whether this login may open the Job Portal
// workspace. The public job link is built by the browser (it knows the
// portal's URL).
async function portalInfo(user, r, apps) {
  const [workspace, publishPerm] = await Promise.all([
    can(user, 'ats', 'requirements', 'Job Portal Workspace', 'view'),
    can(user, 'ats', 'requirements', 'Job Portal Workspace', 'edit'),
  ]);
  return {
    // The SAME rule POST /job-portal/jobs/:id/publish enforces (permission +
    // on the chain / global), so a Publish button is drawn only when the API
    // will take it (an STL / Manager holds Job Posting but not publish).
    canPublish: !!publishPerm && (scopeOf(user).global || isAssignedTo(user, r)),
    published: !!r.portalPublished,
    publishedAt: r.portalPublishedAt || null,
    syncStatus: r.portalSyncStatus || null,
    applications: apps.filter((a) => isPortalSource(a.source) || isPortalSource(a.firstSource)).length,
    workspace,
  };
}

// §15 — "MED-5 · Medical Team", the same wording the detail page uses.
const seatLabel = (p) => (p && p.code ? `${p.code} · ${p.department ? `${p.department} Team` : (p.name || 'Seat')}` : null);

// GET /requirements/:id/summary — what the quick drawer adds to the list row
// for the Requirement 360 (review #3 §4): the assigned team WITH SEATS, the
// agreement, the Job Portal line and the seven-step pipeline (the SAME
// pipelineCounts() the list row and the detail page carry). Lean: stages and
// sources only, never the candidate records.
router.get('/:id/summary', async (req, res) => {
  const r = req.requirement;
  const policy = await viewerPolicy(req.user);
  // The pipeline is the caller's own slice (§7: a recruiter their own
  // candidates, a TL their team's), like the list row's mini pipeline.
  const scopedApps = ['admin', 'mgmt'].includes(policy.role) ? { requirementId: r.id } : { AND: [applicationWhere(req.user), { requirementId: r.id }] };
  const [apps, client, people, seats, clientOpenable, bde, recruiter] = await Promise.all([
    prisma.application.findMany({ where: scopedApps, select: { stage: true, source: true, firstSource: true } }),
    r.clientId ? prisma.client.findUnique({ where: { id: r.clientId }, select: { ...LIST_CLIENT_SELECT } }) : null,
    peopleFor([r]),
    currentSeatsByUser([r.recruiterId, r.tlId, r.stlId, ...csv(r.recruiterIds)]),
    policy.openClient && r.clientId && !r.internal
      ? prisma.client.findFirst({ where: { AND: [{ id: r.clientId }, clientWhere(req.user)] }, select: { id: true } })
      : null,
    r.bdeId ? prisma.user.findUnique({ where: { id: r.bdeId }, select: { id: true, name: true } }) : null,
    r.recruiterId ? prisma.user.findUnique({ where: { id: r.recruiterId }, select: { id: true, name: true } }) : null,
  ]);
  const desk = policy.agreementView;
  const forClient = isClient(req.user);
  const person = (id, name, primary) => (id || name ? { id: id || null, name: name || (id && people.get(id)) || null, seat: seatLabel(id && seats.get(id)), primary: !!primary } : null);
  const agreementStatus = normalizeAgreementStatus(client && client.agreementStatus);
  const out = {
    id: r.id,
    pipeline: pipelineCounts(apps.map((a) => a.stage), { internal: !!r.internal }),
    client: r.internal ? null : clientForRole(client, policy),
    clientLink: !!clientOpenable,
    commercial: r.internal ? undefined : commercialOf(client, policy),
    type: r.internal ? 'INTERNAL' : 'CLIENT',
    agreement: r.internal ? { internal: true } : {
      status: agreementStatus,
      label: AGREEMENT_LABELS[agreementStatus] || agreementStatus,
      active: agreementIsActive(client && client.agreementStatus),
      held: r.status === 'AGREEMENT_CHECK',
      canOpen: desk,
    },
    portal: await portalInfo(req.user, r, apps),
    sections: policy.sections,
  };
  // No Agreements for this role (TL, Recruiter): only whether the gate holds
  // the requirement back — never the agreement's own status or terms.
  if (!r.internal && !policy.agreementView) out.agreement = { active: out.agreement.active, held: out.agreement.held, canOpen: false };
  if (!forClient) {
    out.team = {
      tl: person(r.tlId, (r.tlId && people.get(r.tlId)) || r.tl),
      stl: person(r.stlId, (r.stlId && people.get(r.stlId)) || r.stl),
      recruiters: [
        person(r.recruiterId, recruiter && recruiter.name, true),
        ...csv(r.recruiterIds).filter((id) => id !== r.recruiterId).map((id) => person(id, people.get(id))),
      ].filter(Boolean),
      bde: bde ? { id: bde.id, name: bde.name } : null,
    };
  }
  res.json(out);
});

router.get('/:id', async (req, res) => {
  const requirement = await prisma.requirement.findUnique({
    where: { id: req.params.id },
    include: {
      // The client's working fields — not its agreement text, stamp and
      // signature images or signing secrets (those stay on the Clients module).
      client: { select: DETAIL_CLIENT_SELECT },
      recruiter: { select: PERSON_SELECT },
      bde: { select: PERSON_SELECT },
      applications: { select: DETAIL_APP_SELECT, orderBy: { updatedAt: 'desc' } },
    },
  });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });
  const hasAgreementDocument = !!(requirement.client && requirement.client.agreementDocument);
  if (requirement.client) delete requirement.client.agreementDocument;

  // Role spec §7 — the CANDIDATES PIPELINE section is the caller's own slice:
  // a recruiter their own candidates, a TL their team's (applicationWhere);
  // everyone else every candidate on it. Filtered here, so the rest are not
  // in the response at all.
  const policy = await viewerPolicy(req.user);
  if (!['admin', 'mgmt'].includes(policy.role) && !isClient(req.user) && requirement.applications.length) {
    const visible = new Set((await prisma.application.findMany({
      where: { AND: [applicationWhere(req.user), { requirementId: requirement.id }] }, select: { id: true },
    })).map((a) => a.id));
    requirement.applications = requirement.applications.filter((a) => visible.has(a.id));
  }
  const apps = requirement.applications;
  const stages = apps.map((a) => a.stage);
  const [people, permissions, desk, activityOf, seats, lastWork, manageAgreement, clientOpenable] = await Promise.all([
    peopleFor([requirement]),
    requirementPermissions(req.user, requirement),
    policy.agreementView,
    lastActivityFor([requirement.id]),
    currentSeatsByUser([requirement.recruiterId, requirement.tlId, requirement.stlId, requirement.bdeId, ...csv(requirement.recruiterIds)]),
    prisma.applicationFollowUp.findFirst({
      where: { application: { requirementId: requirement.id }, ownerName: { not: null } },
      select: { ownerName: true, ownerPositionCode: true },
      orderBy: { createdAt: 'desc' },
    }),
    can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'edit'),
    policy.openClient && requirement.clientId && !requirement.internal
      ? prisma.client.findFirst({ where: { AND: [{ id: requirement.clientId }, clientWhere(req.user)] }, select: { id: true } })
      : null,
  ]);
  const filled = stages.filter((s) => ['JOINED', 'HIRED'].includes(s)).length;
  const seatOf = (uid) => {
    const p = uid ? seats.get(uid) : null;
    return p ? { code: p.code, name: p.name || null, department: p.department || null } : null;
  };
  const agreementStatus = normalizeAgreementStatus(requirement.client && requirement.client.agreementStatus);
  const agreementActive = requirement.internal || agreementIsActive(requirement.client && requirement.client.agreementStatus);
  const la = activityOf.get(requirement.id);
  const recruiterSeat = seatOf(requirement.recruiterId);
  // §24 Section (Education Team A / B) — the same rule the list row uses.
  const seatCodes = [recruiterSeat && recruiterSeat.code, lastWork && lastWork.ownerPositionCode,
    seatOf(requirement.tlId) && seatOf(requirement.tlId).code, requirement.positionCode].filter(Boolean);
  const seatByCode = new Map((seatCodes.length
    ? await prisma.position.findMany({ where: { code: { in: seatCodes } }, select: { code: true, team: true, department: true } })
    : []).map((x) => [x.code, x]));
  const section = seatCodes.map((c) => sectionOfCode(c, seatByCode)).find(Boolean) || null;

  const payload = {
    ...requirement,
    // §7 client contact: Admin / Mgmt / BDE full · TL names only · Recruiter
    // and Accounts none. Fee / agreement terms are `commercial` (BDE,
    // Accounts, Admin, Mgmt). Neither is sent to a role that may not see it.
    client: isClient(req.user) ? clientForViewer(requirement.client, false) : clientForRole(requirement.client, policy, { detail: true }),
    commercial: requirement.internal || isClient(req.user) ? undefined : commercialOf(requirement.client, policy),
    clientLink: !!clientOpenable,
    type: requirement.internal ? 'INTERNAL' : 'CLIENT',
    organization: requirement.internal ? 'TeamLink' : (requirement.client ? requirement.client.name : null),
    unassigned: isUnassigned(requirement),
    daysOpen: requirementIsLive(requirement.status) ? ageDaysOf(requirement.createdAt) : null,
    sections: policy.sections,
    viewRole: policy.role,
    tlName: people.get(requirement.tlId) || requirement.tl || null,
    stlName: people.get(requirement.stlId) || requirement.stl || null,
    coRecruiters: csv(requirement.recruiterIds).map((id) => ({ id, name: people.get(id) || id, seat: seatOf(id) })),
    seats: {
      recruiter: recruiterSeat, tl: seatOf(requirement.tlId), stl: seatOf(requirement.stlId), bde: seatOf(requirement.bdeId),
    },
    workedBy: (requirement.recruiter && requirement.recruiter.name) || (lastWork && lastWork.ownerName) || null,
    workedByPosition: (recruiterSeat && recruiterSeat.code) || (lastWork && lastWork.ownerPositionCode) || requirement.positionCode || null,
    section,
    filled,
    remaining: Math.max(0, (requirement.openings || 1) - filled),
    // §7 — the SAME counts the list row and the quick drawer show.
    pipeline: pipelineCounts(stages, { internal: !!requirement.internal }),
    ageDays: ageDaysOf(requirement.createdAt),
    sla: requirementSla(requirement, apps).sla,
    lastActivity: la ? { at: la.at, by: isClient(req.user) ? null : la.by, what: la.what } : null,
    matchThreshold: MATCH_THRESHOLD,
    live: requirementIsLive(requirement.status),
    agreementActive,
    // §2 Agreement tab: status + the next step + whether this login may act
    // on it (the link into the client's Agreement tab is the client desk's).
    agreement: requirement.internal ? { internal: true } : {
      status: agreementStatus,
      label: AGREEMENT_LABELS[agreementStatus] || agreementStatus,
      active: agreementActive,
      nextStep: agreementStepText({ ...requirement.client, agreementDocument: hasAgreementDocument }),
      canOpen: desk,
      canManage: manageAgreement,
      held: requirement.status === 'AGREEMENT_CHECK',
    },
    // Review #3 §4 — the Job Portal line of the Requirement 360.
    portal: await portalInfo(req.user, requirement, apps),
  };

  // §7 Fee / Agreement terms ❌ for a TL and a Recruiter: only whether the
  // agreement gate holds this requirement back, never the agreement itself.
  if (!requirement.internal && !policy.agreementView && !isClient(req.user)) {
    payload.agreement = { active: agreementActive, held: requirement.status === 'AGREEMENT_CHECK', canOpen: false, canManage: false };
  }

  // A client never receives the internal pipeline detail on their own req.
  if (isClient(req.user)) {
    const shaped = shapeForClient(payload);
    delete shaped.seats; delete shaped.coRecruiters; delete shaped.workedBy; delete shaped.workedByPosition;
    shaped.applications = apps.map((a) => ({
      id: a.id, stage: a.stage, candidateId: a.candidateId, candidateName: a.candidate && a.candidate.name,
      interviewAt: a.interviewAt, interviewStatus: a.interviewStatus, joiningDate: a.joiningDate,
    }));
    return res.json({ ...shaped, permissions });
  }
  return res.json({ ...payload, permissions, postingLog: await postingLogOf(requirement.id) });
});

// Recruiter tab — WHO HAS WORKED THIS REQUIREMENT: every person (or import)
// that moved one of its candidates, with how many moves and when last. One
// grouped query over the stage events of this requirement's applications.
router.get('/:id/workers', async (req, res) => {
  if (isClient(req.user)) return res.json([]);
  const rows = await prisma.$queryRaw`SELECT e.actorName AS actor, e.actorRole AS role, e.actorPositionCode AS seat,
      COUNT(*) AS moves, MAX(e.createdAt) AS last
    FROM ApplicationStageEvent e JOIN Application a ON a.id = e.applicationId
    WHERE a.requirementId = ${req.requirement.id}
    GROUP BY e.actorName, e.actorRole, e.actorPositionCode
    ORDER BY last DESC LIMIT 25`;
  const when = (v) => {
    if (v === null || v === undefined) return null;
    const d = typeof v === 'bigint' ? new Date(Number(v)) : new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return res.json(rows.map((r) => ({
    name: r.actor || 'System', role: r.role || null, seat: r.seat || null, moves: Number(r.moves || 0), last: when(r.last),
  })));
});

// Link a candidate — SEARCH, not a download of the whole master. Name, phone
// or email; scoped like the candidate list (utils/scope.js candidateWhere);
// people already on this requirement are left out. At most 20.
router.get('/:id/candidate-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const linked = await prisma.application.findMany({ where: { requirementId: req.requirement.id }, select: { candidateId: true } });
  const rows = await prisma.candidate.findMany({
    where: {
      AND: [
        candidateWhere(req.user),
        { id: { notIn: linked.map((a) => a.candidateId) } },
        { OR: [{ name: { contains: q } }, { phone: { contains: q } }, { email: { contains: q } }] },
      ],
    },
    select: { id: true, name: true, location: true, experienceYears: true },
    orderBy: { name: 'asc' },
    take: 20,
  });
  return res.json(rows);
});

// ---------------------------------------------------------------------------
// POSTING LOG — what really happened on each posting source.
//
// Only the TeamLink Job Portal is published to by this app itself. For the
// others the app cannot post on its own (no live Naukri / Indeed / Shine
// account connection), so what a person DID is recorded here instead — "shared
// on LinkedIn", "posted on Naukri manually, here is the link" — and the
// requirement page shows each source's status from these rows rather than
// claiming a post that never happened. Stored as audit rows (entity
// RequirementPosting): the source in fromValue, the channel or link in toValue.
// ---------------------------------------------------------------------------
const POSTING_LOG_SOURCES = ['Naukri', 'Indeed', 'Shine', 'LinkedIn', 'TeamLink Website', 'Social Media'];
const POSTING_LOG_ACTIONS = ['Shared', 'Posted manually', 'Removed'];

async function postingLogOf(requirementId) {
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'RequirementPosting', entityId: requirementId },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 60,
  });
  return rows.map((r) => ({
    source: r.fromValue, action: r.action, detail: r.toValue || null, by: r.user ? r.user.name : null, at: r.createdAt,
  }));
}

router.post('/:id/posting-log', async (req, res) => {
  const requirement = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });
  const perms = await requirementPermissions(req.user, requirement);
  if (!perms.edit && !perms.share) return res.status(403).json({ error: "Recording postings isn't included in your role's permissions." });
  const source = String(req.body?.source || '').trim();
  const action = String(req.body?.action || '').trim();
  if (!POSTING_LOG_SOURCES.includes(source)) return res.status(400).json({ error: 'Unknown posting source.' });
  if (!POSTING_LOG_ACTIONS.includes(action)) return res.status(400).json({ error: 'Unknown posting action.' });
  // The channel it was shared on, or the link of the listing on that site.
  const detail = String(req.body?.detail || '').trim().slice(0, 500) || null;
  await logAudit({
    userId: req.user.id, action, entity: 'RequirementPosting', entityId: requirement.id, fromValue: source, toValue: detail,
  });
  res.status(201).json({ postingLog: await postingLogOf(requirement.id) });
});

// ---------------------------------------------------------------------------
// "POSTED ON" (user notes #7) — where this requirement is posted, per source:
// Posted / Pending / Failed (+ reason) / Not configured / Feed ready …, and a
// Retry that posts it again now (utils/jobPosting.js). Internal detail — a
// client login is not served it.
// ---------------------------------------------------------------------------
router.get('/:id/postings', async (req, res) => {
  if (isClient(req.user)) return res.status(403).json({ error: 'Posting status is internal to TeamLink.' });
  const perms = await requirementPermissions(req.user, req.requirement);
  const out = await postingChannels(req.requirement);
  return res.json({ ...out, canRetry: !!(perms.edit || perms.share) });
});

router.post('/:id/postings/retry', async (req, res) => {
  if (isClient(req.user)) return res.status(403).json({ error: 'Posting is internal to TeamLink.' });
  const perms = await requirementPermissions(req.user, req.requirement);
  if (!perms.edit && !perms.share) return res.status(403).json({ error: "Posting isn't included in your role's permissions for this requirement." });
  if (!requirementIsLive(req.requirement.status)) {
    return res.status(400).json({ error: `A requirement at "${requirementStatusLabel(req.requirement.status)}" is not posted anywhere — reopen it first.` });
  }
  const result = await autoPost(req.requirement.id, { actorId: req.user.id, actorName: req.user.name, trigger: 'retry' });
  const fresh = await prisma.requirement.findUnique({ where: { id: req.requirement.id } });
  const out = await postingChannels(fresh);
  return res.json({
    ...out,
    canRetry: true,
    result: result.push && !result.push.ok ? { ok: false, error: result.push.error } : { ok: result.ok !== false },
  });
});

// ---------------------------------------------------------------------------
// ELIGIBLE CANDIDATES IN THIS LOCATION (user notes #6).
//
// "Based on a requirement's location, show how many candidates at that
// location are eligible." A candidate is in the location when their current
// OR preferred location falls in one of the requirement's cities, city names
// normalised (Hyderabad = Secunderabad = Hyd = Kukatpally …, utils/
// locationMatch.js); a multi-location requirement counts each city. Of those,
// `strong` are the ones the existing matcher (utils/matching.js) scores at
// 60% or more on skills / experience / the rest. SCOPED like the matching
// list: only candidates this login may see (candidateWhere) — never another
// team's. Two grouped queries turn cities into exact location values, so the
// database filters; only the candidates in those cities are scored.
// ---------------------------------------------------------------------------
const LOCATION_STRONG = 60;
router.get('/:id/location-candidates', requirePerm('ats', 'requirements', 'Matching Candidates', 'view'), async (req, res) => {
  const requirement = req.requirement;
  const cities = citiesOf(requirement.location);
  const perms = await requirementPermissions(req.user, requirement);
  const base = {
    location: requirement.location || null,
    cities: cities.map((c) => c.label),
    threshold: LOCATION_STRONG,
    canAdd: !!perms.pipelineEdit && requirementIsLive(requirement.status),
  };
  if (!cities.length) return res.json({ ...base, total: 0, strong: 0, alreadyLinked: 0, byCity: [], rows: [] });
  const keys = cities.map((c) => c.key);
  const scope = candidateWhere(req.user);
  const [byLoc, byPref, linked] = await Promise.all([
    prisma.candidate.groupBy({ by: ['location'], where: scope, _count: { _all: true } }),
    prisma.candidate.groupBy({ by: ['preferredLocation'], where: scope, _count: { _all: true } }),
    prisma.application.findMany({ where: { requirementId: requirement.id }, select: { candidateId: true } }),
  ]);
  const locValues = valuesInCities(byLoc.map((g) => g.location), keys);
  const prefValues = valuesInCities(byPref.map((g) => g.preferredLocation), keys);
  const or = [
    ...(locValues.length ? [{ location: { in: locValues } }] : []),
    ...(prefValues.length ? [{ preferredLocation: { in: prefValues } }] : []),
  ];
  if (!or.length) return res.json({ ...base, total: 0, strong: 0, alreadyLinked: 0, byCity: cities.map((c) => ({ city: c.label, count: 0 })), rows: [] });
  const found = await prisma.candidate.findMany({
    where: { AND: [scope, { OR: or }] },
    select: { ...MATCH_CANDIDATE_SELECT, phone: true },
  });
  const linkedIds = new Set(linked.map((a) => a.candidateId));
  const scored = found.map((c) => {
    const m = computeMatch(c, requirement);
    const inCities = [...new Set([...citiesOf(c.location), ...citiesOf(c.preferredLocation)].filter((x) => keys.includes(x.key)).map((x) => x.label))];
    return { c, overall: m.overall, skillsPct: m.skillsPct, matchedSkills: m.matchedSkills, inCities };
  });
  const byCity = cities.map((ct) => ({ city: ct.label, count: scored.filter((x) => x.inCities.includes(ct.label)).length }));
  const strong = scored.filter((x) => x.overall >= LOCATION_STRONG);
  const rows = scored
    .filter((x) => !linkedIds.has(x.c.id))
    .sort((a, b) => b.overall - a.overall)
    .slice(0, 20)
    .map((x) => ({
      id: x.c.id, name: x.c.name, location: x.c.location, preferredLocation: x.c.preferredLocation,
      experienceYears: x.c.experienceYears, skills: x.c.skills,
      match: x.overall, skillsPct: x.skillsPct, matchedSkills: x.matchedSkills, cities: x.inCities,
      strong: x.overall >= LOCATION_STRONG,
    }));
  return res.json({
    ...base,
    total: scored.length,
    strong: strong.length,
    strongNotLinked: strong.filter((x) => !linkedIds.has(x.c.id)).length,
    alreadyLinked: scored.filter((x) => linkedIds.has(x.c.id)).length,
    byCity,
    rows,
  });
});

// Suggested candidates for this requirement — everyone not already in the
// pipeline who clears the match threshold, ranked, with the reasons behind the
// score. Mirrors the prototype's matchingCandidatesFor()/matchingCandidatesView().
router.get('/:id/matching-candidates', requirePerm('ats', 'requirements', 'Matching Candidates', 'view'), async (req, res) => {
  const requirement = req.requirement;
  const [candidates, linked] = await Promise.all([
    // Only the columns the matcher (utils/matching.js) and the table read —
    // not every column of 16,900 candidates.
    // SCOPED (review #3 §17 access audit): suggestions are drawn from the
    // candidates this login may see — the same rule as the candidate list and
    // GET /:id/candidate-search — never another team's candidates.
    prisma.candidate.findMany({ where: candidateWhere(req.user), select: MATCH_CANDIDATE_SELECT }),
    prisma.application.findMany({ where: { requirementId: requirement.id }, select: { candidateId: true } }),
  ]);

  // The prototype's requirement detail lists suggestions down to 50%, while the
  // "Matching Candidates" count tile only counts those at or above 70%.
  const ranked = rankCandidates(candidates, requirement, {
    excludeIds: new Set(linked.map((a) => a.candidateId)),
    threshold: req.query.threshold ? Number(req.query.threshold) : SUGGESTION_THRESHOLD,
  });
  // ?limit=N — the detail page's shape: the top N plus the counts, instead of
  // shipping every one of thousands of suggestions to draw eight of them.
  if (req.query.limit) {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    return res.json({
      rows: ranked.slice(0, limit),
      total: ranked.length,
      strong: ranked.filter((c) => c.match.overall >= MATCH_THRESHOLD).length,
      threshold: MATCH_THRESHOLD,
    });
  }
  return res.json(ranked);
});

// §23 — THE REQUIREMENT'S ACTIVITY: who did what, when, and why. One feed
// from two sources, newest first:
//   * the requirement's own audit rows — created, edited (one row per field),
//     assigned, status changes, job postings;
//   * the stage events of its applications — candidate added, moved to TL
//     Review, BDE sent to client, client shortlisted, interview scheduled,
//     rejected (with the reason) …
// Person ids in assignment rows are shown as names. A client login sees only
// the requirement's own rows, never names or internal reasons.
const ID_LIKE = /^c[a-z0-9]{20,}$/;
router.get('/:id/activity', async (req, res) => {
  const forClient = isClient(req.user);
  const limit = Math.min(300, Math.max(10, Number(req.query.limit) || 100));
  const id = req.requirement.id;
  const [audits, events] = await Promise.all([
    prisma.auditLog.findMany({
      where: { entity: { in: ['Requirement', 'RequirementPosting'] }, entityId: id },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    forClient ? [] : prisma.applicationStageEvent.findMany({
      where: { application: { requirementId: id } },
      select: {
        id: true, createdAt: true, action: true, fromStage: true, toStage: true, actorName: true, actorRole: true,
        comment: true, reasonCategory: true, reasonDetail: true, candidate: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
  ]);
  // Names for any person id an assignment row recorded.
  const tokens = new Set();
  audits.forEach((a) => [a.fromValue, a.toValue].forEach((v) => String(v || '').split(/[\s/,]+/).forEach((t) => { if (ID_LIKE.test(t)) tokens.add(t); })));
  const names = tokens.size
    ? new Map((await prisma.user.findMany({ where: { id: { in: [...tokens] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map();
  const humanise = (v) => (v ? String(v).replace(/c[a-z0-9]{20,}/g, (t) => names.get(t) || t) : v);

  const items = [
    ...audits.map((a) => ({
      id: `a-${a.id}`,
      kind: a.entity === 'RequirementPosting' ? 'posting' : 'requirement',
      action: a.entity === 'RequirementPosting' ? `${a.action} — ${a.fromValue}` : a.action,
      fromValue: a.entity === 'RequirementPosting' ? null : humanise(a.fromValue),
      toValue: humanise(a.toValue),
      // followup_: Edit Requirement writes one row per changed field, so the
      // trail can say "Job Title: Staff Nurse → Staff Nurse (ICU)".
      field: a.field,
      fieldLabel: a.fieldLabel,
      reason: forClient ? null : a.reason,
      createdAt: a.createdAt,
      by: forClient ? null : (a.user ? a.user.name : (a.actorName || 'System')),
    })),
    ...events.map((e) => ({
      id: `e-${e.id}`,
      kind: 'candidate',
      action: e.action,
      candidateId: e.candidate ? e.candidate.id : null,
      candidateName: e.candidate ? e.candidate.name : null,
      fromValue: e.fromStage ? stageLabel(e.fromStage) : null,
      toValue: e.toStage ? stageLabel(e.toStage) : null,
      reason: [e.reasonCategory, e.reasonDetail, e.comment].filter(Boolean).join(' — ') || null,
      createdAt: e.createdAt,
      by: e.actorName || 'System',
      role: e.actorRole || null,
    })),
  ].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)).slice(0, limit);
  res.json(items);
});

// Every field the prototype's collectRequirementForm() (line 7062) gathers,
// plus the clireq assignment chain and portal sync. Section letters match the
// prototype's Create Requirement modal headings: A Basic Information,
// B Client Information, C Job Description, D Job Conditions, E Compensation,
// F Assignment, G Job Posting.
const REQUIREMENT_FIELDS = [
  'title', 'description', 'department', 'priority', 'openings', 'closingDate', 'internal',
  'jobDescription', 'responsibilities', 'qualifications', 'education', 'skills', 'goodToHaveSkills',
  'employmentType', 'workMode', 'location', 'preferredLocation', 'experience', 'relevantExperience',
  'joiningTimeline', 'noticePeriodMax', 'jobPreference',
  'salaryType', 'currency', 'salary',
  'recruiterId', 'bdeId', 'tl', 'stl', 'postingSources',
  // clireq
  'tlId', 'stlId', 'recruiterIds', 'targetDate', 'accountManager', 'portalSyncStatus',
];

function pickRequirement(body) {
  const data = {};
  for (const key of REQUIREMENT_FIELDS) {
    if (body[key] === undefined) continue;
    if (key === 'openings') data.openings = Number(body.openings) || 1;
    else if (key === 'internal') data.internal = Boolean(body.internal);
    // "— Not assigned —" arrives as an empty string; a relation field has to be
    // null, not '', or the write fails on a foreign key that does not exist.
    else if (['recruiterId', 'bdeId', 'tlId', 'stlId'].includes(key)) data[key] = body[key] || null;
    else if (key === 'recruiterIds') {
      data.recruiterIds = Array.isArray(body.recruiterIds)
        ? body.recruiterIds.filter(Boolean).join(',')
        : (body.recruiterIds || null);
    } else data[key] = body[key];
  }
  return data;
}

// REQ-0001, REQ-0002 … the human-facing Requirement ID.
async function nextRequirementCode() {
  const used = await prisma.requirement.count();
  for (let n = used + 1; n < used + 500; n += 1) {
    const code = `REQ-${String(n).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await prisma.requirement.findFirst({ where: { reqCode: code }, select: { id: true } });
    if (!clash) return code;
  }
  return `REQ-${Date.now()}`;
}

// Tell the people now on the chain that they have been given the requirement.
async function notifyAssignment(requirement, actorId, verb = 'assigned to you') {
  const ids = [requirement.recruiterId, requirement.bdeId, requirement.tlId, requirement.stlId,
    ...csv(requirement.recruiterIds)];
  // And the TL of each assigned recruiter's SEAT (Positions -> reportsTo):
  // the team lead hears that one of their seats was given work even when the
  // requirement does not name them as its TL.
  const seatLeads = await teamLeadUserIdsFor([requirement.recruiterId, ...csv(requirement.recruiterIds)]).catch(() => []);
  seatLeads.forEach((id) => { if (!ids.includes(id)) ids.push(id); });
  await notifyUsers(ids, {
    title: `Requirement ${requirement.reqCode || requirement.title} ${verb}`,
    message: `${requirement.title} — ${requirement.department || 'no department'}.`,
    exceptUserId: actorId,
  });
}

// AN INTERNAL REQUIREMENT HAS NO CLIENT — BUT THE ROW MUST NAME ONE.
// Requirement.clientId is required, so hiring for TeamLink itself is filed
// under one client record that stands for the company: found by type, made
// once if it is missing, and reused by every internal requirement after.
async function internalClientId() {
  const existing = await prisma.client.findFirst({ where: { clientType: 'Internal' }, select: { id: true } });
  if (existing) return existing.id;
  const company = await prisma.company.findFirst().catch(() => null);
  const name = `${(company && (company.name || company.legalName)) || 'TeamLink Consultants'} — Internal Hiring`;
  const made = await prisma.client.create({ data: { name, clientType: 'Internal', status: 'Active', priority: 'Medium' } });
  return made.id;
}

// Every person the form names must be a real login, checked BEFORE the write,
// so a stale pick gets a sentence instead of a foreign-key failure.
async function badAssignee(data) {
  const fields = [['recruiterId', 'recruiter'], ['bdeId', 'BDE'], ['tlId', 'TL'], ['stlId', 'STL']];
  const ids = [...fields.map(([f]) => data[f]), ...csv(data.recruiterIds)].filter(Boolean);
  if (!ids.length) return null;
  const found = new Set((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((u) => u.id));
  const missing = fields.find(([f]) => data[f] && !found.has(data[f]));
  if (missing) return `The selected ${missing[1]} is no longer on file — pick them again.`;
  if (csv(data.recruiterIds).some((id) => !found.has(id))) return 'One of the co-recruiters is no longer on file — untick and pick again.';
  return null;
}

// The checks every save shares, as sentences a person can act on. Returns the
// first problem, or null. `creating` adds the checks that only make sense on a
// new requirement (a closing date already in the past).
const PRIORITY_VALUES = ['Low', 'Medium', 'High', 'Urgent'];
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(new Date(v).getTime());
function requirementProblem(body, data, { creating = false } = {}) {
  if (body.openings !== undefined && body.openings !== '') {
    const n = Number(body.openings);
    if (!Number.isInteger(n) || n < 1 || n > 999) return 'Number of Openings must be a whole number from 1 to 999.';
  }
  if (data.priority && !PRIORITY_VALUES.includes(data.priority)) return `Priority must be one of ${PRIORITY_VALUES.join(', ')}.`;
  for (const [key, label] of [['closingDate', 'Closing Date'], ['targetDate', 'Target Date']]) {
    if (data[key] && !isDay(data[key])) return `${label} is not a valid date — pick it from the calendar.`;
  }
  if (creating) {
    const today = new Date().toISOString().slice(0, 10);
    if (data.closingDate && data.closingDate < today) return 'Closing Date is in the past — pick today or a later date.';
    if (data.targetDate && data.targetDate < today) return 'Target Date is in the past — pick today or a later date.';
  }
  return null;
}

// The seat (Position) a recruiter sits in today — a requirement given to
// MED-1 stays MED-1 work after the person in MED-1 changes (schema note on
// Requirement.positionId). Null when they hold no seat.
async function seatOfRecruiter(userId) {
  if (!userId) return null;
  const row = await prisma.positionAssignment.findFirst({
    where: { toDate: null, employee: { userId } },
    orderBy: { fromDate: 'desc' },
    select: { position: { select: { id: true, code: true } } },
  });
  return row && row.position ? row.position : null;
}

router.post('/', requirePerm('ats', 'requirements', 'Create Requirement', 'create'), async (req, res) => {
  const { status } = req.body;
  let { clientId } = req.body;
  const data = pickRequirement(req.body);
  // Prototype saveNewRequirement(): title, full job description and at least
  // one mandatory skill are required unless the requirement is saved as Draft.
  if (!String(data.title || '').trim()) return res.status(400).json({ error: 'Enter a job title.', field: 'title' });
  data.title = String(data.title).trim();
  const asDraft = status === 'DRAFT';
  if (!asDraft) {
    if (!String(data.jobDescription || data.description || '').trim()) {
      return res.status(400).json({ error: 'Enter the full job description (or use Save Draft to finish it later).', field: 'jobDescription' });
    }
    if (!String(data.skills || '').trim()) {
      return res.status(400).json({ error: 'Enter at least one mandatory skill (comma separated).', field: 'skills' });
    }
    if (!String(data.department || '').trim()) return res.status(400).json({ error: 'Select a department.', field: 'department' });
  }
  const problem = requirementProblem(req.body, data, { creating: true });
  if (problem) return res.status(400).json({ error: problem });

  // An internal requirement carries no client; a client requirement must name one.
  if (!data.internal && !clientId) {
    return res.status(400).json({ error: 'Select a client for a client requirement (or choose Requirement Type: Internal Requirement).', field: 'clientId' });
  }
  if (data.internal) clientId = await internalClientId();
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return res.status(400).json({ error: 'That client is no longer on file — select the client again.', field: 'clientId' });
  // A client the caller cannot see is not one they can raise work for.
  if (!data.internal && !(await prisma.client.findFirst({ where: { AND: [{ id: clientId }, clientPickerWhere(req.user)] }, select: { id: true } }))) {
    return res.status(403).json({ error: 'That client is outside your scope — pick one of the clients in your list.', field: 'clientId' });
  }
  if (data.internal) data.bdeId = null;

  // THE CREATOR STAYS ON THEIR OWN REQUIREMENT. Scope is the assignment chain
  // (utils/scope.js), so a TL who raised a requirement without naming a TL —
  // or naming another team's recruiter — could not see it the moment it was
  // saved. Whoever raises it is put on the chain in their own role when that
  // slot is empty; an explicit choice is never overridden.
  const role = scopeOf(req.user).atsRole;
  if (role === 'TL' && !data.tlId) { data.tlId = req.user.id; data.tl = data.tl || req.user.name || null; }
  if (role === 'STL' && !data.stlId) { data.stlId = req.user.id; data.stl = data.stl || req.user.name || null; }
  if (role === 'BDE' && !data.internal && !data.bdeId) data.bdeId = req.user.id;

  const assigneeProblem = await badAssignee(data);
  if (assigneeProblem) return res.status(400).json({ error: assigneeProblem });

  // The recruiter's SEAT, so the work is filed under the position as well as
  // the person (positions are permanent — utils/positionScope.js).
  const seat = await seatOfRecruiter(data.recruiterId);
  if (seat) { data.positionId = seat.id; data.positionCode = seat.code; }

  // THE AGREEMENT GATE. A client requirement cannot go live until its client's
  // agreement is ACTIVE. Rather than refusing the save outright it now parks
  // the requirement in AGREEMENT_CHECK, which is the state the workflow names:
  //   Draft -> Agreement Check -> Open -> ...
  let requirementStatus = 'DRAFT';
  let gateNote = null;
  if (!asDraft) {
    if (data.internal) requirementStatus = 'OPEN';
    else if (!agreementIsActive(client.agreementStatus)) {
      requirementStatus = 'AGREEMENT_CHECK';
      gateNote = await agreementGateNote(req.user, client);
    } else {
      requirementStatus = 'OPEN';
    }
  }
  // A requirement that already names a recruiter starts one step further on.
  if (requirementStatus === 'OPEN' && (data.recruiterId || csv(data.recruiterIds).length)) {
    requirementStatus = 'RECRUITER_ASSIGNED';
  }

  const requirement = await prisma.requirement.create({
    data: {
      ...data,
      clientId,
      hiringType: data.internal ? 'TeamLink Internal Hire' : 'Client Placement',
      reqCode: await nextRequirementCode(),
      priority: data.priority || 'Medium',
      status: requirementStatus,
      description: data.description || data.jobDescription || data.title,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Requirement created', entity: 'Requirement',
    entityId: requirement.id, toValue: requirementStatus,
  });
  await notifyAssignment(requirement, req.user.id);
  // A requirement that is live the moment it is saved is posted on every
  // source now; one parked at Draft / Agreement Check posts when it goes live.
  await pushToPortal(requirement, { user: req.user, trigger: 'create' });
  res.status(201).json({ ...requirement, gateNote, agreementStatus: normalizeAgreementStatus(client.agreementStatus) });
});

// EXACTLY WHAT TO DO when a client requirement is held at the agreement gate
// — the steps for someone who can complete the agreement, and who to ask for
// someone who cannot (Agreement Lifecycle is Super Admin / Admin; the client
// record itself is the client desk's).
const AGREEMENT_LABELS = {
  DRAFT: 'Draft', SENT: 'Sent', VIEWED: 'Viewed', CLIENT_CONFIRMATION_PENDING: 'Client Confirmation Pending',
  SIGNED: 'Signed (not yet activated)', ACTIVE: 'Active', EXPIRED: 'Expired', REJECTED: 'Rejected',
};
// The next step on the client's agreement, as a sentence (Agreement tab of
// Requirement Detail, and the gate note below).
function agreementStepText(client) {
  const status = normalizeAgreementStatus(client && client.agreementStatus);
  if (status === 'ACTIVE') return 'Nothing — the agreement is Active, so this requirement may go live.';
  return {
    DRAFT: client && client.agreementDocument
      ? 'Send to Client, the client signs, then Activate Agreement'
      : 'Generate Agreement, Send to Client, the client signs, then Activate Agreement',
    SENT: 'wait for the client to sign (Resend if needed), then Activate Agreement',
    VIEWED: 'wait for the client to sign (Request Client Confirmation if needed), then Activate Agreement',
    CLIENT_CONFIRMATION_PENDING: 'wait for the client to sign, then Activate Agreement',
    SIGNED: 'press Activate Agreement',
    EXPIRED: 'Regenerate the agreement, Send to Client, the client signs, then Activate Agreement',
    REJECTED: 'Regenerate or upload a new agreement, Send to Client, the client signs, then Activate Agreement',
  }[status] || 'complete the agreement';
}

async function agreementGateNote(user, client) {
  const status = normalizeAgreementStatus(client.agreementStatus);
  const label = AGREEMENT_LABELS[status] || status;
  const [manage, desk] = await Promise.all([
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'edit'),
    can(user, 'ats', 'clients', 'Client List', 'view'),
  ]);
  const step = agreementStepText(client);
  const head = `Saved at Agreement Check — not live yet, because the service agreement with ${client.name} is ${label}.`;
  const tail = 'When the agreement is Active, open this requirement and press Activate Requirement.';
  if (manage) return `${head} To make it live: Clients → ${client.name} → Agreement tab → ${step}. ${tail}`;
  if (desk) return `${head} An Admin must complete it (Clients → ${client.name} → Agreement tab → ${step}). ${tail}`;
  return `${head} Ask the BDE or an Admin who owns ${client.name} to complete the agreement. ${tail}`;
}

// ---------------------------------------------------------------------------
// EDIT REQUIREMENT.
//
// Open a saved requirement and change its fields. The screen reuses the
// Create Requirement form (frontend/src/components/RequirementForm.jsx — one
// form, two modes), and this endpoint is the same PUT it always was, with two
// things it was missing:
//
//   1. THE ASSIGNMENT CHAIN IS NOT AN EDIT. tlId / stlId / recruiterId /
//      recruiterIds / bdeId / accountManager decide WHO CAN SEE THIS RECORD
//      (utils/scope.js requirementWhere). Changing them is a scope change, so
//      it needs the `assign` action, not `edit` — the same split POST
//      /:id/assign already enforces. A recruiter holds `edit` on requirements
//      they are assigned and does NOT hold `assign`; before this, `edit`
//      quietly carried the whole chain with it and a recruiter could have
//      handed their own requirement to somebody else, or taken someone
//      else's co-recruiter seat, through the edit form.
//
//   2. A FIELD-LEVEL AUDIT TRAIL. "Requirement updated" with no values told
//      nobody anything. Every changed field is now one row —
//      Field · Old Value · New Value · Changed By · Changed At — written by
//      the same utils/audit.js logFieldChanges() the employee lifecycle uses.
// ---------------------------------------------------------------------------

// The fields that decide scope. Kept next to the rule they serve.
const ASSIGNMENT_FIELDS = ['recruiterId', 'bdeId', 'tlId', 'stlId', 'recruiterIds', 'accountManager'];

// Human labels for the audit trail, so a row reads "Job Title" and not "title".
const FIELD_LABELS = {
  title: 'Job Title',
  description: 'Description',
  department: 'Department',
  priority: 'Priority',
  openings: 'Number of Openings',
  closingDate: 'Closing Date',
  internal: 'Requirement Type',
  jobDescription: 'Job Description',
  responsibilities: 'Responsibilities',
  qualifications: 'Qualifications',
  education: 'Education',
  skills: 'Mandatory Skills',
  goodToHaveSkills: 'Good-to-have Skills',
  employmentType: 'Employment Type',
  workMode: 'Work Mode',
  location: 'Location',
  preferredLocation: 'Preferred Location',
  experience: 'Experience',
  relevantExperience: 'Relevant Experience',
  joiningTimeline: 'Joining Timeline',
  noticePeriodMax: 'Maximum Notice Period',
  jobPreference: 'Job Preference',
  salaryType: 'Salary Type',
  currency: 'Currency',
  salary: 'Salary Range',
  targetDate: 'Target Date',
  postingSources: 'Posting Sources',
  portalSyncStatus: 'Job Portal Sync',
  recruiterId: 'Assigned Recruiter',
  bdeId: 'BDE',
  tlId: 'Assigned TL',
  stlId: 'STL',
  recruiterIds: 'Co-recruiters',
  accountManager: 'Account Manager',
  tl: 'TL (name)',
  positionCode: 'Recruiter Code',
  stl: 'STL (name)',
};

const sameValue = (a, b) => {
  const norm = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
  return norm(a) === norm(b);
};

router.put('/:id', requirePerm('ats', 'requirements', 'Requirement Detail', 'edit'), async (req, res, next) => {
  try {
    // VIEW != EDIT: holding the edit action is not enough — the record has to
    // be one this user is actually on, unless their scope is global.
    const perms = await requirementPermissions(req.user, req.requirement);
    if (!perms.edit) return res.status(403).json({ error: perms.readOnlyReason || OUT_OF_SCOPE.error });

    const before = req.requirement;
    const data = pickRequirement(req.body);

    // --- the assignment gate ------------------------------------------------
    const touchedAssignment = ASSIGNMENT_FIELDS
      .filter((k) => k in data && !sameValue(data[k], before[k]));
    if (touchedAssignment.length && !perms.assign) {
      return res.status(403).json({
        error: 'Changing the assignment chain is a scope change and needs the assign permission, '
          + 'not edit. Ask a TL or an admin to re-assign this requirement.',
        fields: touchedAssignment.map((k) => FIELD_LABELS[k] || k),
      });
    }
    // Fields the caller may not change are dropped rather than silently kept
    // in the update — a request that tried nothing is never refused, so an
    // edit form that round-trips unchanged assignment values still works.
    if (!perms.assign) ASSIGNMENT_FIELDS.forEach((k) => { delete data[k]; });

    // status only moves through /activate, /assign and /status, which enforce
    // the agreement gate — it is deliberately not editable here.
    delete data.status;
    // The client is not editable here either: moving a requirement to another
    // client re-decides the agreement gate and the whole commercial record.
    delete data.clientId;
    // Nor is the Requirement Type: flipping a client requirement to internal
    // would walk it round the agreement gate. And the portal sync status moves
    // only through POST /:id/portal-sync and the Job Portal, which check it.
    delete data.internal;
    delete data.portalSyncStatus;
    const problem = requirementProblem(req.body, data);
    if (problem) return res.status(400).json({ error: problem });
    if ('title' in data && !String(data.title || '').trim()) return res.status(400).json({ error: 'Job title cannot be empty.', field: 'title' });
    // A new primary recruiter brings their seat with them.
    if ('recruiterId' in data && !sameValue(data.recruiterId, before.recruiterId)) {
      const seat = await seatOfRecruiter(data.recruiterId);
      if (seat) { data.positionId = seat.id; data.positionCode = seat.code; }
    }

    const changes = Object.keys(data)
      .filter((k) => k !== 'positionId' && !sameValue(data[k], before[k]))
      .map((k) => ({ field: k, label: FIELD_LABELS[k] || k, from: before[k], to: data[k] }));

    if (!changes.length) {
      return res.json({ ...before, unchanged: true });
    }

    const requirement = await prisma.requirement.update({ where: { id: before.id }, data });

    // One summary row for the activity strip …
    await logAudit({
      userId: req.user.id,
      action: 'Requirement updated',
      entity: 'Requirement',
      entityId: requirement.id,
      actorName: req.user.name,
      fromValue: `${changes.length} field(s)`,
      toValue: changes.map((c) => c.label).join(', '),
      reason: req.body.editReason || null,
    });
    // … and one row per field, so the trail says what actually changed.
    await logFieldChanges({
      userId: req.user.id,
      actorName: req.user.name,
      entity: 'Requirement',
      entityId: requirement.id,
      action: 'Requirement field changed',
      changes,
      approvalStatus: null, // an edit is not a review — see utils/audit.js
      reason: req.body.editReason || null,
    });

    // Someone whose assignment changed finds out, exactly as POST /:id/assign
    // already tells them.
    if (touchedAssignment.length) await notifyAssignment(requirement, req.user.id, 'assignment updated');
    // A requirement that has ever been on the TeamLink Job Portal is re-pushed,
    // so the posting there says what the requirement now says.
    await pushToPortal(requirement, { user: req.user, trigger: 'edit' });

    return res.json({ ...requirement, changedFields: changes.map((c) => c.label) });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/assign — the assignment chain.
//   Requirement -> Assigned TL -> Assigned Recruiter(s) -> BDE -> Client
// This is a SEPARATE permission from edit: a lead may re-assign work they do
// not otherwise edit, and a recruiter may edit a requirement they cannot
// re-assign.
// ---------------------------------------------------------------------------
router.post('/:id/assign', requirePerm('ats', 'requirements', 'Requirement Detail', 'assign'), async (req, res) => {
  const perms = await requirementPermissions(req.user, req.requirement);
  const s = scopeOf(req.user);
  // A lead assigning work for the first time is not yet "on" the record, so an
  // unassigned requirement inside their scope is assignable; a requirement
  // already owned by someone else is not, unless their scope is global.
  const unclaimed = !req.requirement.tlId && !req.requirement.recruiterId && !req.requirement.recruiterIds;
  if (!perms.assign && !(s.global || unclaimed)) {
    return res.status(403).json({ error: 'This requirement is assigned to someone else.' });
  }

  const before = req.requirement;
  const data = {};
  ['tlId', 'stlId', 'recruiterId', 'bdeId'].forEach((k) => {
    if (req.body[k] !== undefined) data[k] = req.body[k] || null;
  });
  if (req.body.recruiterIds !== undefined) {
    data.recruiterIds = Array.isArray(req.body.recruiterIds)
      ? req.body.recruiterIds.filter(Boolean).join(',')
      : (req.body.recruiterIds || null);
  }
  if (req.body.accountManager !== undefined) data.accountManager = req.body.accountManager || null;

  // Assigning a recruiter to a live requirement advances the workflow.
  const willHaveRecruiter = (data.recruiterId !== undefined ? data.recruiterId : before.recruiterId)
    || csv(data.recruiterIds !== undefined ? data.recruiterIds : before.recruiterIds).length;
  if (willHaveRecruiter && before.status === 'OPEN') data.status = 'RECRUITER_ASSIGNED';
  // Stale picks get a sentence, not a foreign-key failure.
  const assigneeProblem = await badAssignee(data);
  if (assigneeProblem) return res.status(400).json({ error: assigneeProblem });
  // A new primary recruiter brings their seat with them.
  if (data.recruiterId !== undefined && !sameValue(data.recruiterId, before.recruiterId)) {
    const seat = await seatOfRecruiter(data.recruiterId);
    if (seat) { data.positionId = seat.id; data.positionCode = seat.code; }
  }

  const requirement = await prisma.requirement.update({ where: { id: before.id }, data });
  await logAudit({
    userId: req.user.id,
    action: 'Requirement assignment changed',
    entity: 'Requirement',
    entityId: requirement.id,
    fromValue: [before.tlId, before.recruiterId, before.bdeId].filter(Boolean).join(' / ') || 'unassigned',
    toValue: [requirement.tlId, requirement.recruiterId, requirement.bdeId].filter(Boolean).join(' / ') || 'unassigned',
  });
  await notifyAssignment(requirement, req.user.id);
  res.json(requirement);
});

// VIEW != APPROVE. Holding the approve action is not enough to open, hold or
// close a requirement you can merely SEE — the same record-level rule the
// detail page draws its buttons from (requirementPermissions().approve).
async function approveDenied(user, record) {
  const perms = await requirementPermissions(user, record);
  return perms.approve ? null : 'You can view this requirement, but it is not assigned to you — ask its TL or an Admin to change its status.';
}

// The agreement-gate refusal, with the exact steps (see agreementGateNote).
async function gateRefusal(user, client, lead) {
  if (!client) return `${lead} — the client agreement is not Active.`;
  const note = await agreementGateNote(user, client);
  return `${lead}: ${note.replace(/^Saved at Agreement Check — not live yet, because /, '').replace(' When the agreement is Active, open this requirement and press Activate Requirement.', ' Then press Activate Requirement here.')}`;
}

// Activate — the agreement gate. Draft / Agreement Check -> Open.
router.post('/:id/activate', requirePerm('ats', 'requirements', 'Requirement Detail', 'approve'), async (req, res) => {
  const existing = await prisma.requirement.findUnique({ where: { id: req.params.id }, include: { client: true } });
  const denied = await approveDenied(req.user, existing);
  if (denied) return res.status(403).json({ error: denied });
  if (requirementIsLive(existing.status)) return res.status(400).json({ error: 'This requirement is already open' });
  // The gate is an ACTIVE agreement, not merely a signed one. Internal
  // requirements have no client agreement to wait on.
  if (!existing.internal && !agreementIsActive(existing.client && existing.client.agreementStatus)) {
    await prisma.requirement.update({ where: { id: existing.id }, data: { status: 'AGREEMENT_CHECK' } });
    return res.status(400).json({
      error: await gateRefusal(req.user, existing.client, 'Cannot activate yet — it is held at Agreement Check'),
    });
  }

  const status = (existing.recruiterId || csv(existing.recruiterIds).length) ? 'RECRUITER_ASSIGNED' : 'OPEN';
  const requirement = await prisma.requirement.update({ where: { id: req.params.id }, data: { status } });
  await logAudit({
    userId: req.user.id, action: 'Requirement activated', entity: 'Requirement',
    entityId: requirement.id, fromValue: existing.status, toValue: status,
  });
  await pushToPortal(requirement, { user: req.user, trigger: 'status', prevStatus: existing.status });
  res.json(requirement);
});

// ---------------------------------------------------------------------------
// POST /:id/status — the rest of the workflow.
//   Draft -> Agreement Check -> Open -> Recruiter Assigned -> Sourcing
//     -> Candidates Available -> On Hold / Closed
// Each hop is checked: you cannot skip the agreement gate, you cannot say
// "Recruiter Assigned" with nobody assigned, and you cannot claim candidates
// are available when the pipeline is empty.
// ---------------------------------------------------------------------------
const NEXT_STATUS = {
  DRAFT: ['AGREEMENT_CHECK', 'OPEN', 'CLOSED'],
  AGREEMENT_CHECK: ['OPEN', 'DRAFT', 'CLOSED'],
  OPEN: ['RECRUITER_ASSIGNED', 'SOURCING', 'ON_HOLD', 'CLOSED'],
  RECRUITER_ASSIGNED: ['SOURCING', 'OPEN', 'ON_HOLD', 'CLOSED'],
  SOURCING: ['CANDIDATES_AVAILABLE', 'RECRUITER_ASSIGNED', 'ON_HOLD', 'CLOSED'],
  CANDIDATES_AVAILABLE: ['SOURCING', 'ON_HOLD', 'CLOSED'],
  ON_HOLD: ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE', 'CLOSED'],
  CLOSED: ['OPEN', 'DRAFT'],
};

router.post('/:id/status', requirePerm('ats', 'requirements', 'Requirement Detail', 'approve'), async (req, res) => {
  const existing = await prisma.requirement.findUnique({ where: { id: req.params.id }, include: { client: true, _count: { select: { applications: true } } } });
  const denied = await approveDenied(req.user, existing);
  if (denied) return res.status(403).json({ error: denied });
  const to = String(req.body.status || '').toUpperCase();
  if (!REQUIREMENT_STATUS_CODES.includes(to)) return res.status(400).json({ error: 'Unknown requirement status.' });
  // Role spec §7 — a BDE may CLOSE a requirement of their own client; Reopen,
  // Hold and every other move are Admin's.
  if (atsViewRole(req.user) === 'bde' && to !== 'CLOSED') {
    return res.status(403).json({ error: 'A BDE can close a requirement, but reopening or holding it is an Admin action.' });
  }
  const allowed = NEXT_STATUS[existing.status] || [];
  if (!allowed.includes(to)) {
    return res.status(400).json({
      error: `A requirement at "${requirementStatusLabel(existing.status)}" cannot move to "${requirementStatusLabel(to)}". `
        + `From here it can go to: ${allowed.map((x) => requirementStatusLabel(x)).join(', ') || 'nowhere'}.`,
    });
  }
  if (requirementIsLive(to) && !existing.internal && !agreementIsActive(existing.client && existing.client.agreementStatus)) {
    return res.status(400).json({ error: await gateRefusal(req.user, existing.client, 'Cannot go live yet') });
  }
  if (to === 'RECRUITER_ASSIGNED' && !existing.recruiterId && !csv(existing.recruiterIds).length) {
    return res.status(400).json({ error: 'Assign a recruiter before moving to Recruiter Assigned.' });
  }
  if (to === 'CANDIDATES_AVAILABLE' && !existing._count.applications) {
    return res.status(400).json({ error: 'No candidates in the pipeline yet.' });
  }

  const requirement = await prisma.requirement.update({ where: { id: existing.id }, data: { status: to } });
  await logAudit({
    userId: req.user.id, action: 'Requirement status changed', entity: 'Requirement',
    entityId: requirement.id, fromValue: existing.status, toValue: to,
  });
  await pushToPortal(requirement, { user: req.user, trigger: 'status', prevStatus: existing.status });
  res.json(requirement);
});

// Open/close toggle — the prototype's toggleRequirementStatus(), kept so the
// existing button and any caller still work.
router.post('/:id/toggle-status', requirePerm('ats', 'requirements', 'Requirement Detail', 'approve'), async (req, res) => {
  const existing = req.requirement;
  const denied = await approveDenied(req.user, existing);
  if (denied) return res.status(403).json({ error: denied });
  const status = requirementIsLive(existing.status) ? 'CLOSED' : 'OPEN';
  if (status !== 'CLOSED' && atsViewRole(req.user) === 'bde') {
    return res.status(403).json({ error: 'A BDE can close a requirement, but reopening it is an Admin action.' });
  }
  if (status === 'OPEN' && !existing.internal) {
    const client = await prisma.client.findUnique({ where: { id: existing.clientId } });
    if (!agreementIsActive(client && client.agreementStatus)) {
      return res.status(400).json({ error: await gateRefusal(req.user, client, 'Cannot reopen yet') });
    }
  }
  const requirement = await prisma.requirement.update({ where: { id: existing.id }, data: { status } });
  await logAudit({
    userId: req.user.id, action: 'Requirement status toggled', entity: 'Requirement',
    entityId: requirement.id, fromValue: existing.status, toValue: status,
  });
  await pushToPortal(requirement, { user: req.user, trigger: 'status', prevStatus: existing.status });
  res.json(requirement);
});

// DELETE (role spec §6 / §7 — Admin only). Only a requirement that never got
// any work: one with a candidate or an invoice on it is refused (409) — close
// it instead. Nothing is cascaded.
router.delete('/:id', requirePerm('ats', 'requirements', 'Requirement Detail', 'delete'), async (req, res) => {
  const r = req.requirement;
  const [apps, invoices] = await Promise.all([
    prisma.application.count({ where: { requirementId: r.id } }),
    prisma.invoice.count({ where: { requirementId: r.id } }),
  ]);
  if (apps || invoices) {
    return res.status(409).json({
      error: `${r.reqCode || 'This requirement'} has ${apps} candidate(s) and ${invoices} invoice(s) on it — close it instead of deleting it.`,
    });
  }
  await prisma.requirement.delete({ where: { id: r.id } });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Requirement deleted', entity: 'Requirement',
    entityId: r.id, fromValue: `${r.reqCode || ''} ${r.title || ''}`.trim(), toValue: 'deleted',
  });
  return res.json({ ok: true, id: r.id });
});

// Job Portal sync status. The portal itself is another module's; this records
// where the requirement stands with it, which the detail screen shows.
router.post('/:id/portal-sync', requirePerm('ats', 'requirements', 'Job Posting', 'edit'), async (req, res) => {
  // OWNERSHIP, not only scope (review #3 access audit): seeing a requirement
  // is not being on its chain — the same rule as PUT /:id (requirementPermissions).
  if (!(await requirementPermissions(req.user, req.requirement)).share) {
    return res.status(403).json({ error: 'You can see this requirement, but you are not on its assignment chain' });
  }
  const to = String(req.body.portalSyncStatus || '');
  if (!['Not Synced', 'Pending', 'Synced', 'Failed'].includes(to)) {
    return res.status(400).json({ error: 'Unknown portal sync status.' });
  }
  if (to === 'Synced' && !requirementIsLive(req.requirement.status)) {
    return res.status(400).json({ error: 'Only a live requirement can be marked Synced to the job portal.' });
  }
  const requirement = await prisma.requirement.update({
    where: { id: req.requirement.id },
    data: { portalSyncStatus: to },
  });
  await logAudit({
    userId: req.user.id, action: 'Job portal sync status set', entity: 'Requirement',
    entityId: requirement.id, fromValue: req.requirement.portalSyncStatus, toValue: to,
  });
  res.json(requirement);
});

// Templated job description built from the requirement + client — the
// prototype's jobDescriptionHtml(). Saved onto description, which is what the
// public Job Portal (routes/public.js) already shows candidates.
router.post('/:id/generate-jd', requirePerm('ats', 'requirements', 'Job Posting', 'edit'), async (req, res) => {
  // OWNERSHIP, not only scope (review #3 access audit): seeing a requirement
  // is not being on its chain — the same rule as PUT /:id (requirementPermissions).
  if (!(await requirementPermissions(req.user, req.requirement)).share) {
    return res.status(403).json({ error: 'You can see this requirement, but you are not on its assignment chain' });
  }
  const requirement = await prisma.requirement.findUnique({ where: { id: req.params.id }, include: { client: true } });
  if (!requirement) return res.status(404).json({ error: 'Requirement not found' });

  // The prototype's jobDescriptionHtml() (line 6398): the JD is assembled from
  // the requirement's own recorded fields, in this section order, rather than
  // from boilerplate. Rendered as plain text so it can be stored in SQLite and
  // served by the public job portal.
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const skills = list(requirement.skills);
  const goodToHave = list(requirement.goodToHaveSkills);
  const row = (k, v) => (v ? `${k}: ${v}` : null);

  const description = [
    requirement.title,
    `${requirement.internal ? 'Internal TeamLink hiring' : requirement.client ? requirement.client.name : '—'} · ` +
      `${requirement.location || '—'} · ${requirement.workMode || '—'}`,
    '',
    'About the role',
    requirement.jobDescription || requirement.description || 'No description recorded yet.',
    ...(requirement.responsibilities ? ['', 'Responsibilities', requirement.responsibilities] : []),
    ...(requirement.qualifications ? ['', 'Qualifications', requirement.qualifications] : []),
    '',
    'Skills',
    `${skills.join(', ') || '—'} (mandatory)`,
    `${goodToHave.join(', ') || '—'} (good to have)`,
    '',
    'Details',
    ...[
      row('Experience', requirement.experience),
      row('Relevant experience', requirement.relevantExperience),
      row('Education', requirement.education),
      row('Location', requirement.location),
      row('Preferred location', requirement.preferredLocation),
      row('Work mode', requirement.workMode),
      row('Employment type', requirement.employmentType),
      row('Salary range', requirement.salary),
      row('Notice period', requirement.noticePeriodMax),
      row('Joining timeline', requirement.joiningTimeline),
      row('Openings', requirement.openings),
      row('Closing date', requirement.closingDate),
      row('Target date', requirement.targetDate),
    ].filter(Boolean),
    ...(!requirement.internal && requirement.client
      ? [
        '',
        'About the client',
        [requirement.client.name, requirement.client.industry, requirement.client.location].filter(Boolean).join(' · '),
      ]
      : []),
  ].join('\n');

  const updated = await prisma.requirement.update({ where: { id: requirement.id }, data: { description } });
  await logAudit({ userId: req.user.id, action: 'Job description generated', entity: 'Requirement', entityId: requirement.id });
  res.json(updated);
});

module.exports = router;
