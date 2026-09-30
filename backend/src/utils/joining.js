// ---------------------------------------------------------------------------
// Joining — the fork in the road, in one place.
//
// Every requirement and every application carries a HIRING TYPE, and the whole
// downstream flow turns on it:
//
//   Client Placement        Selected -> Offer -> Offer Accepted -> Documents
//                           -> Joining Scheduled -> Joined Client
//                           -> Billing Pending -> Invoice -> Receivable
//                           -> Payment -> Bank Reconciliation
//
//   TeamLink Internal Hire  Selected -> Internal Offer -> Accepted -> Documents
//                           -> Joining Scheduled -> Joined -> Hired
//                           -> HRMS Employee Creation -> HRMS
//
// The two rules this file exists to hold:
//   1. ONLY a client placement ever raises an invoice.
//   2. ONLY an internal hire ever becomes an HRMS employee. A selected client
//      candidate is the CLIENT's employee, never TeamLink's, and must never be
//      pushed into HRMS.
//
// raiseJoiningInvoice() below is the invoice-on-joining path that used to live
// inline in routes/applications.js (the prototype's confirmClientJoining, line
// 9099). It moved here unchanged in arithmetic so that the pipeline stage move
// and the Joining workspace both call the SAME one — there is no second
// invoice path.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { logAudit } = require('./audit');

const CLIENT_PLACEMENT = 'Client Placement';
const INTERNAL_HIRE = 'TeamLink Internal Hire';
const HIRING_TYPES = [CLIENT_PLACEMENT, INTERNAL_HIRE];

const OFFER_STATUSES = ['Not Issued', 'Offer Released', 'Offer Accepted', 'Offer Declined'];
const DOCUMENT_STATUSES = ['Pending', 'Submitted', 'Verified'];
const JOINING_STATUSES = ['Not Scheduled', 'Joining Scheduled', 'Joined', 'Dropped'];
const BILLING_STATUSES = ['Not Applicable', 'Billing Pending', 'Invoiced'];

// The stored hiringType wins; a row written before the column existed falls
// back to the requirement's own internal flag. Never guessed from anything else.
function hiringTypeOf(application, requirement) {
  if (application && application.hiringType) return application.hiringType;
  const req = requirement || (application && application.requirement);
  if (req && req.hiringType) return req.hiringType;
  if (req && req.internal) return INTERNAL_HIRE;
  return CLIENT_PLACEMENT;
}

function isInternalHire(application, requirement) {
  return hiringTypeOf(application, requirement) === INTERNAL_HIRE;
}

// yyyy-mm-dd plus n days.
function offsetDate(from, days) {
  const d = from ? new Date(from) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// ATS -> Accounts. Candidate Joined -> Billing Pending -> Invoice -> Receivable.
//
// Every figure comes from the client's agreed commercial terms:
//   amount = annual CTC x the agreement's fee %
//   GST    = amount x the client's GST %      (added — the client pays it)
//   TDS    = amount x the client's TDS %      (deducted at source)
//   what the client actually transfers = amount + GST - TDS
//     (utils/accounts.js invoiceTotal — the single definition of that sum)
//   invoice date = joining + 6 days, due date = invoice + 6 days (joining + 12)
//
// Raised exactly once, keyed on candidate + requirement.
// ---------------------------------------------------------------------------
async function raiseJoiningInvoice({ application, existing, userId }) {
  const requirement = existing.requirement;
  const client = requirement && requirement.client;
  if (!client) return null;

  // Rule 1: an internal TeamLink hire is not billable to anyone. No invoice.
  if (isInternalHire(application, requirement)) return null;

  const already = await prisma.invoice.findFirst({
    where: { candidateId: existing.candidateId, requirementId: existing.requirementId },
  });
  if (already) return already;

  // Fee % comes from the agreement. Falls back to the annual CTC band on the
  // requirement when no offered CTC was recorded — never to a random number.
  const feePercent = client.agreementFeePercent != null ? client.agreementFeePercent : 8.33;
  const bandLakhs = Number(String(requirement.salary || '').match(/(\d+(?:\.\d+)?)/)?.[1]) || 12;
  const ctc = Number(application.offeredCtc) > 0 ? Number(application.offeredCtc) : bandLakhs * 100000;
  const gstPercent = client.gstPercent != null ? client.gstPercent : 18;
  const tdsPercent = client.tdsPercent != null ? client.tdsPercent : 10;
  const amount = Math.round((ctc * feePercent) / 100);
  const gst = Math.round(amount * (gstPercent / 100));
  const tds = Math.round(amount * (tdsPercent / 100));

  const joiningDate = application.joiningDate || new Date().toISOString().slice(0, 10);
  const invoice = await prisma.invoice.create({
    data: {
      clientId: client.id,
      candidateId: existing.candidateId,
      requirementId: existing.requirementId,
      amount,
      gst,
      tds,
      // The rates actually applied to THIS invoice, so the register and the
      // printable invoice never have to re-derive them from the client.
      gstPercent,
      tdsPercent,
      status: 'Pending',
      joiningDate,
      invoiceDate: offsetDate(joiningDate, 6),
      dueDate: offsetDate(joiningDate, 12),
      feePercent,
      offeredCtc: ctc,
      paymentTerms: client.paymentTerms || 'Invoice 6 days after joining; payment due within 6 days of invoice',
    },
  });
  await logAudit({
    userId, action: 'Invoice generated from ATS (Client Joining)', entity: 'Invoice',
    entityId: invoice.id, toValue: 'Pending',
  });
  return invoice;
}

// ---------------------------------------------------------------------------
// TeamLink internal hire -> HRMS. One employee = one user = one login, so the
// employee record is created here and Administration -> Users issues the login
// against it; nothing about a client placement ever reaches this function.
// ---------------------------------------------------------------------------
const DEFAULT_ONBOARDING_TASKS = [
  'Offer letter signed', 'ID proof collected', 'PAN card collected',
  'Laptop/asset assigned', 'Reporting manager introduction', 'System access provisioned',
];

async function createHrmsEmployee({ application, candidate, requirement, userId }) {
  // Rule 2: never for a client placement.
  if (!isInternalHire(application, requirement)) return null;
  if (application.hrmsEmployeeId) {
    return prisma.employee.findUnique({ where: { id: application.hrmsEmployeeId } });
  }

  // The next TL<nnn> — the same series Add Employee issues (utils/employeeCode.js).
  // eslint-disable-next-line global-require
  const employeeCode = await require('./employeeCode').nextEmployeeCode();
  const employee = await prisma.employee.create({
    data: {
      employeeCode,
      name: candidate.name,
      email: candidate.email || null,
      phone: candidate.phone || null,
      department: requirement.department || null,
      designation: requirement.title || null,
      location: candidate.location || requirement.location || null,
      branch: requirement.location || null,
      employeeType: requirement.employmentType === 'Contract' ? 'Contract' : 'Full-time',
      employmentStatus: 'On Probation',
      employmentExperience: Number(candidate.experienceYears) > 0 ? 'Experienced' : 'Fresher',
      skills: candidate.skills || null,
      dateOfJoining: application.joiningDate ? new Date(application.joiningDate) : new Date(),
      onboardingTasks: JSON.stringify(DEFAULT_ONBOARDING_TASKS.map((task) => ({ task, completed: false }))),
    },
  });
  await prisma.application.update({
    where: { id: application.id },
    data: { hrmsEmployeeId: employee.id },
  });
  await logAudit({
    userId,
    action: 'HRMS employee created from ATS (TeamLink Internal Hire)',
    entity: 'Employee',
    entityId: employee.id,
    toValue: employeeCode,
  });
  return employee;
}

// ---------------------------------------------------------------------------
// The ONE place a joining is recorded, whichever screen triggered it — the
// Joining workspace's "Mark Joined", or a stage move to Joined on the
// candidate pipeline. It stamps the joining columns and then forks:
//   Client Placement  -> Billing Pending -> invoice raised -> Invoiced
//   Internal Hire     -> Not Applicable  -> no invoice, ever
// HRMS employee creation is NOT done here: an internal hire reaches HRMS only
// through the explicit "Create HRMS Employee" action on Internal Hiring.
// ---------------------------------------------------------------------------
async function onApplicationJoined({ application, existing, userId }) {
  const internal = isInternalHire(application, existing.requirement);
  await prisma.application.update({
    where: { id: application.id },
    data: {
      hiringType: hiringTypeOf(application, existing.requirement),
      joiningStatus: 'Joined',
      joinedAt: application.joinedAt || new Date(),
      billingStatus: internal ? 'Not Applicable' : 'Billing Pending',
    },
  });
  if (internal) return null;
  const invoice = await raiseJoiningInvoice({ application, existing, userId });
  if (invoice) {
    await prisma.application.update({
      where: { id: application.id },
      data: { billingStatus: 'Invoiced' },
    });
  }
  return invoice;
}

// ---------------------------------------------------------------------------
// SELECTED DOES NOT LEAD TO ONE PLACE. IT BRANCHES.
//
// The pipeline runs SELECTED -> OFFER -> OFFER_ACCEPTED -> JOINED for every
// application, and for a CLIENT PLACEMENT that is wrong. TeamLink does not
// extend an offer to somebody it is placing at Orbit — Orbit does. The offer
// stages are an INTERNAL HIRE concept, and running a client placement through
// them produces a pipeline that says TeamLink offered a job it never offered.
//
//   SELECTED
//      |
//      +-- Client Placement --> JOINED --> invoice --> payment --> bank
//      |                        (the client confirms the joining)
//      |
//      +-- Internal Hire ----> OFFER --> OFFER_ACCEPTED --> JOINED
//                              (we make the offer, so these stages are real)
//                                                            --> HRMS employee
//
// The END of the branch was already right: onApplicationJoined() raises an
// invoice for a placement and creates an HRMS employee for an internal hire,
// and has done since it was written. What was missing is the MIDDLE — nothing
// stopped a client placement being walked through OFFER first.
//
// Returns null when the move is fine, or a sentence saying why it is not.
// ---------------------------------------------------------------------------
const OFFER_STAGES = ['OFFER', 'OFFER_ACCEPTED'];
// THE ACTUAL WORKFLOW (2026-09-29) supersedes the branch drawn above in one
// respect: a CLIENT placement also goes Selected → Offer → Offer Accepted →
// Joining. The offer is the client's; the recruiter RECORDS it (with the CTC
// the placement fee is worked out on). So the offer stages are no longer
// refused for a client placement. What stays true: only a client placement
// is invoiced, only an internal hire reaches HRMS, and an internal hire has
// no BDE / client steps at all.
const CLIENT_ONLY_STAGES = ['WITH_BDE', 'BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'];

function stageAllowedForHiringType(toStage, application, requirement) {
  const internal = isInternalHire(application, requirement);
  if (internal && CLIENT_ONLY_STAGES.includes(toStage)) {
    return 'This is a TeamLink internal hire — there is no BDE review or client submission. '
      + 'After HR Review and the Dept Head / TL approval the candidate goes to Interview.';
  }
  // §35 — HIRED is the internal-hire end state (it hands over to HRMS). A
  // client placement ends at Joined, which hands over to Accounts.
  if (!internal && toStage === 'HIRED') {
    return 'Hired is for TeamLink internal hires (it creates the HRMS employee). A client placement '
      + 'ends at Joined — the client confirms the joining and Accounts raises the invoice.';
  }
  return null;
}

// The named moves available FROM a stage, for this kind of hire. The UI draws
// buttons from this, so a recruiter never sees a button the server will
// refuse — which is the only honest way to offer one.
function nextActionsFor(stage, application, requirement) {
  const internal = isInternalHire(application, requirement);
  if (stage !== 'SELECTED') return null;
  return internal
    ? [
      { id: 'extend_offer', label: 'Extend Offer', to: 'OFFER' },
      { id: 'hold', label: 'Hold', to: 'HOLD' },
      { id: 'reject', label: 'Reject', to: 'REJECTED' },
    ]
    : [
      // The client's offer, recorded (Offers → Record Offer, with the CTC).
      { id: 'record_offer', label: 'Record Offer', to: 'OFFER' },
      { id: 'hold', label: 'Hold', to: 'HOLD' },
      { id: 'reject', label: 'Reject', to: 'REJECTED' },
    ];
}

module.exports = {
  OFFER_STAGES,
  CLIENT_ONLY_STAGES,
  stageAllowedForHiringType,
  nextActionsFor,
  CLIENT_PLACEMENT,
  INTERNAL_HIRE,
  HIRING_TYPES,
  OFFER_STATUSES,
  DOCUMENT_STATUSES,
  JOINING_STATUSES,
  BILLING_STATUSES,
  hiringTypeOf,
  isInternalHire,
  offsetDate,
  raiseJoiningInvoice,
  createHrmsEmployee,
  onApplicationJoined,
};
