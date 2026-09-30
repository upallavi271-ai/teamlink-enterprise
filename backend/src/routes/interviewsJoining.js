// ---------------------------------------------------------------------------
// Interviews & Joining — Interview Feedback, Offers, Joining, Internal Hiring.
//
// Mounted alongside routes/atsExtras.js on /api/ats (the Interview Calendar
// itself lives there). The three things this file is careful about:
//
//   1. STATUS vs RESULT. Where the interview IS (Scheduled … Feedback
//      Submitted … Cancelled) is not what it DECIDED (Selected / Rejected /
//      Hold). They are separate columns and nothing here mixes them.
//
//   2. INTERNAL feedback vs CLIENT feedback. Two rows in InterviewFeedback on
//      the same interview, never merged — and neither is ever merged with the
//      AI interview score, which stays on Application.aiInterviewScore and is
//      shown only on the calendar's AI tab.
//
//   3. CLIENT PLACEMENT vs TEAMLINK INTERNAL HIRE. A client placement joins
//      the client and hands off to Accounts (invoice -> receivable). An
//      internal hire becomes a TeamLink employee in HRMS. NEITHER path ever
//      runs the other's step: a placed candidate is never pushed into HRMS,
//      and an internal hire never raises an invoice.
//
// Permissions come from THE engine (utils/permissions.js) and data scope from
// utils/scope.js — a recruiter sees their own, a TL their department's, a BDE
// their clients', a client their own company's, a candidate their own.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { applicationWhere, scopeOf, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const {
  interviewStatusLabel, stageLabel, INTERVIEW_RECOMMENDATIONS, normalizeRecommendation,
} = require('../utils/atsVocab');
const {
  INTERNAL_HIRE, HIRING_TYPES, OFFER_STATUSES, DOCUMENT_STATUSES,
  hiringTypeOf, isInternalHire, createHrmsEmployee, onApplicationJoined,
  stageAllowedForHiringType,
} = require('../utils/joining');
const { REJECTED_BY, REJECTED_BY_LABEL } = require('../utils/atsVocab');
// §32 — every stage these routes move writes Pipeline History, candidate
// communications, follow-ups and the next person's notification.
const { recordWorkflowMove } = require('../utils/stageEvents');
// Guarantee / replacement after a client joining (the actual workflow,
// 2026-09-29): guarantee days from the client's agreed terms; a placement who
// leaves inside them is flagged "Replacement Due" on Application.joiningStatus.
const { guaranteeDaysOf } = require('../utils/workflowFlow');
const {
  guaranteeEndOf, JOINING_REPLACEMENT_DUE, JOINING_REPLACED, JOINING_LEFT_AFTER_GUARANTEE,
} = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const FULL_INCLUDE = {
  candidate: true,
  requirement: { include: { client: true, recruiter: true, bde: true } },
  interviewFeedbacks: true,
};

// Every list and every single-record action runs through the same scope
// fragment as the rest of ATS. A record outside it is not "hidden" — the query
// never returns it, and the action is refused.
async function loadScoped(req, res) {
  const app = await prisma.application.findFirst({
    where: { id: req.params.id, ...applicationWhere(req.user) },
    include: FULL_INCLUDE,
  });
  if (!app) {
    const exists = await prisma.application.findUnique({ where: { id: req.params.id } });
    if (exists) res.status(403).json(OUT_OF_SCOPE);
    else res.status(404).json({ error: 'Application not found' });
    return null;
  }
  return app;
}

function ownerOf(app) {
  const r = app.requirement || {};
  return (r.recruiter && r.recruiter.name) || (r.bde && r.bde.name) || r.tl || '—';
}

function feedbackOf(app, kind) {
  return (app.interviewFeedbacks || []).find((f) => f.kind === kind) || null;
}

// The Result of an interview: what the feedback recommended, else what the
// pipeline already decided. Legacy wording is read back as the current three.
function decisionOf(app) {
  const internal = feedbackOf(app, 'Internal');
  if (internal) return internal.recommendation;
  const legacy = normalizeRecommendation(app.interviewResult);
  if (legacy) return legacy;
  if (['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(app.stage)) return 'Selected';
  if (app.stage === 'REJECTED') return 'Rejected';
  if (app.stage === 'HOLD') return 'Hold';
  return '—';
}

function shapeFeedback(f) {
  if (!f) return null;
  return {
    id: f.id,
    kind: f.kind,
    technical: f.technical,
    communication: f.communication,
    experience: f.experience,
    roleFit: f.roleFit,
    overall: f.overall,
    recommendation: f.recommendation,
    submittedBy: f.submittedBy,
    createdAt: f.createdAt,
  };
}

function shapeRow(app) {
  const req = app.requirement || {};
  return {
    id: app.id,
    interviewCode: app.interviewCode || `INT-${app.id.slice(-6).toUpperCase()}`,
    candidate: { id: app.candidate.id, name: app.candidate.name, email: app.candidate.email },
    requirement: {
      id: req.id,
      title: req.title,
      department: req.department,
      tl: req.tl,
      internal: !!req.internal,
      salary: req.salary,
      client: req.client ? { id: req.client.id, name: req.client.name } : null,
      recruiter: req.recruiter ? { id: req.recruiter.id, name: req.recruiter.name } : null,
      bde: req.bde ? { id: req.bde.id, name: req.bde.name } : null,
    },
    hiringType: hiringTypeOf(app, req),
    stage: app.stage,
    stageLabel: stageLabel(app.stage),
    interviewAt: app.interviewAt,
    interviewType: app.interviewType,
    interviewer: app.interviewer,
    status: app.interviewStatus,
    statusLabel: interviewStatusLabel(app.interviewStatus),
    score: app.interviewScore,
    result: decisionOf(app),
    internalFeedback: shapeFeedback(feedbackOf(app, 'Internal')),
    clientFeedback: shapeFeedback(feedbackOf(app, 'Client')),
    // The AI score travels as its own field and is never folded into either
    // feedback record — the calendar's AI tab is the only place it is acted on.
    aiScore: app.aiInterviewScore,
    offerStatus: app.offerStatus || 'Not Issued',
    offerDate: app.offerDate,
    offerNotes: app.offerNotes,
    offeredCtc: app.offeredCtc,
    documentsStatus: app.documentsStatus || 'Pending',
    joiningDate: app.joiningDate,
    joiningStatus: app.joiningStatus || 'Not Scheduled',
    billingStatus: app.billingStatus || (isInternalHire(app, req) ? 'Not Applicable' : 'Billing Pending'),
    hrmsEmployeeId: app.hrmsEmployeeId,
    owner: ownerOf(app),
  };
}

const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
function filterOptionsFor(rows) {
  return {
    departments: uniq(rows.map((r) => r.requirement.department)),
    clients: uniq(rows.map((r) => r.requirement.client?.name)),
    requirements: uniq(rows.map((r) => r.requirement.title)),
    candidates: uniq(rows.map((r) => r.candidate.name)),
    recruiters: uniq(rows.map((r) => r.requirement.recruiter?.name)),
    tls: uniq(rows.map((r) => r.requirement.tl)),
    bdes: uniq(rows.map((r) => r.requirement.bde?.name)),
    hiringTypes: HIRING_TYPES,
  };
}

async function listScoped(req, where) {
  const rows = await prisma.application.findMany({
    where: { ...applicationWhere(req.user), ...where },
    include: FULL_INCLUDE,
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(shapeRow);
}

// ---------------------------------------------------------------------------
// Interview Feedback
//   Completed -> Feedback Pending -> Feedback Submitted -> Decision
// Internal feedback is submitted on the calendar or here; client feedback is
// submitted by the client, separately, and sits beside it.
// ---------------------------------------------------------------------------
router.get('/feedback', requirePerm('ats', 'interviews', 'Interview Feedback', 'view'), async (req, res) => {
  const rows = await listScoped(req, {
    interviewStatus: { in: ['COMPLETED', 'PENDING_FEEDBACK', 'FEEDBACK_SUBMITTED'] },
  });
  res.json({ rows, filterOptions: filterOptionsFor(rows), recommendations: INTERVIEW_RECOMMENDATIONS });
});

function readRatings(body) {
  const out = {};
  ['technical', 'communication', 'experience', 'roleFit'].forEach((k) => {
    const v = body[k];
    if (v === '' || v == null) { out[k] = null; return; }
    const n = Math.round(Number(v));
    out[k] = Number.isNaN(n) ? null : Math.max(1, Math.min(5, n));
  });
  return out;
}

// CLIENT feedback. A client may only ever reach their own company's interview,
// and what they write is stored as its own record — it never overwrites, and
// is never averaged into, the internal panel's feedback.
router.post('/interviews/:id/client-feedback', requirePerm('ats', 'interviews', 'Client Feedback', 'create'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  const s = scopeOf(req.user);
  if (s.role === 'CLIENT' && app.requirement.clientId !== s.clientId) {
    return res.status(403).json(OUT_OF_SCOPE);
  }
  if (!app.interviewStatus) return res.status(400).json({ error: 'No interview on this application' });
  const overall = (req.body.overall || '').trim();
  if (!overall) return res.status(400).json({ error: 'Overall feedback is required' });
  const recommendation = normalizeRecommendation(req.body.recommendation);
  if (!recommendation) return res.status(400).json({ error: 'Recommendation must be Selected, Rejected or Hold' });

  const data = {
    ...readRatings(req.body),
    overall,
    recommendation,
    submittedById: req.user.id,
    submittedBy: req.user.name,
    clientId: app.requirement.clientId,
  };
  await prisma.interviewFeedback.upsert({
    where: { applicationId_kind: { applicationId: app.id, kind: 'Client' } },
    create: { applicationId: app.id, kind: 'Client', ...data },
    update: data,
  });
  await logAudit({
    userId: req.user.id, action: `Client interview feedback submitted — ${recommendation}`,
    entity: 'Application', entityId: app.id, toValue: recommendation,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json(shapeRow(fresh));
});

// The decision that closes the feedback loop. It moves the PIPELINE; it does
// not touch the interview's status, which stays Feedback Submitted.
const DECISION_STAGE = { Selected: 'SELECTED', Rejected: 'REJECTED', Hold: 'HOLD' };
router.post('/interviews/:id/decision', requirePerm('ats', 'interviews', 'Interview Feedback', 'approve'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  const decision = normalizeRecommendation(req.body.decision);
  if (!decision) return res.status(400).json({ error: 'Decision must be Selected, Rejected or Hold' });
  if (!feedbackOf(app, 'Internal') && !feedbackOf(app, 'Client') && app.interviewStatus !== 'FEEDBACK_SUBMITTED') {
    return res.status(409).json({ error: 'Record interview feedback before taking the decision' });
  }
  // The decision closes an INTERVIEW. Without this a stale Decision button
  // could pull a Joined (invoiced) candidate back to Selected.
  if (!['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'HOLD'].includes(app.stage)) {
    return res.status(409).json({ error: `The interview decision was already taken — this candidate is at ${stageLabel(app.stage)}` });
  }
  // STAGE OWNERSHIP — the same rule as the pipeline's own moves
  // (routes/applications.js applyStageMove -> permissions.js canMoveToStage):
  // Selected belongs to the client side / the leads, so a Recruiter or a BDE
  // cannot mark someone Selected from here either.
  // eslint-disable-next-line global-require
  const stageRefusal = await require('../utils/permissions').canMoveToStage(req.user, DECISION_STAGE[decision]);
  if (stageRefusal) return res.status(stageRefusal.status).json(stageRefusal.body);
  // A rejection says why and whose decision it was — the same rule as the
  // pipeline's own Reject (routes/applications.js applyStageMove).
  let rejectionSide = null;
  if (decision === 'Rejected') {
    rejectionSide = String(req.body.rejectedBy || '').trim();
    if (!REJECTED_BY.includes(rejectionSide)) {
      return res.status(400).json({ error: `Say whose decision the rejection was: ${REJECTED_BY.map((s) => REJECTED_BY_LABEL[s]).join(', ')}.` });
    }
    if (!String(req.body.reasonCategory || '').trim() && !String(req.body.reasonDetail || '').trim()) {
      return res.status(400).json({ error: 'Give a reason for the rejection.' });
    }
  }
  const updated = await prisma.application.update({
    where: { id: app.id },
    data: {
      stage: DECISION_STAGE[decision],
      hiringType: hiringTypeOf(app, app.requirement),
      ...(decision === 'Selected' ? { offerStatus: app.offerStatus || 'Not Issued' } : {}),
    },
  });
  await logAudit({
    userId: req.user.id, action: `Interview decision — ${decision}`, entity: 'Application',
    entityId: app.id, fromValue: stageLabel(app.stage), toValue: stageLabel(updated.stage),
  });
  await recordWorkflowMove({
    user: req.user,
    existing: app,
    application: updated,
    toStage: updated.stage,
    action: `Interview decision — ${decision}`,
    comment: req.body.comment,
    reasonCategory: req.body.reasonCategory,
    reasonDetail: req.body.reasonDetail,
    rejectionSide,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json(shapeRow(fresh));
});

// ---------------------------------------------------------------------------
// Offers
//   Selected -> Offer (released) -> Offer Accepted -> Documents
// The offer is an "Internal Offer" when the hiring type says so; it is the
// same record, and the UI says which it is.
// ---------------------------------------------------------------------------
const OFFER_STAGES = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];

router.get('/offers', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
  // §35 — an offer is a TeamLink INTERNAL-hire step. A selected client
  // placement goes to Joining (Client Joining) instead; client rows already
  // at an offer stage (written before this rule) still show, so nobody is
  // stranded.
  // THE ACTUAL WORKFLOW (2026-09-29): BOTH kinds of hire go Selected → Offer
  // → Offer Accepted → Joining. A client placement's offer is the client's,
  // RECORDED here (with the CTC the placement fee is worked out on); an
  // internal hire's is TeamLink's own. The row says which (hiringType).
  const rows = await listScoped(req, { stage: { in: OFFER_STAGES } });
  res.json({ rows, filterOptions: filterOptionsFor(rows), offerStatuses: OFFER_STATUSES, documentStatuses: DOCUMENT_STATUSES });
});

router.post('/offers/:id/release', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (app.stage !== 'SELECTED' && app.offerStatus !== 'Offer Declined') {
    return res.status(409).json({ error: `An offer follows Selected — this candidate is at ${stageLabel(app.stage)}` });
  }
  // §35 — the same hiring-type rule the pipeline enforces. This route used to
  // skip it, so a client placement could be walked through Offer here.
  const wrongBranch = stageAllowedForHiringType('OFFER', app, app.requirement);
  if (wrongBranch) return res.status(409).json({ error: wrongBranch });
  const ctc = Number(req.body.offeredCtc);
  if (!(ctc > 0)) return res.status(400).json({ error: 'An offered CTC is required' });
  const offerDate = req.body.offerDate || new Date().toISOString().slice(0, 10);
  const hiringType = hiringTypeOf(app, app.requirement);
  await prisma.application.update({
    where: { id: app.id },
    data: {
      stage: 'OFFER',
      hiringType,
      offerStatus: 'Offer Released',
      offerDate,
      offeredCtc: ctc,
      offerNotes: (req.body.offerNotes || '').trim() || null,
      documentsStatus: app.documentsStatus || 'Pending',
      joiningStatus: app.joiningStatus || 'Not Scheduled',
      billingStatus: hiringType === INTERNAL_HIRE ? 'Not Applicable' : 'Billing Pending',
    },
  });
  await logAudit({
    userId: req.user.id,
    action: hiringType === INTERNAL_HIRE ? 'Internal offer released' : 'Offer released',
    entity: 'Application', entityId: app.id, fromValue: stageLabel(app.stage), toValue: 'Offer',
  });
  await recordWorkflowMove({
    user: req.user, existing: app, toStage: 'OFFER',
    action: hiringType === INTERNAL_HIRE ? 'Internal offer released' : 'Offer released',
    comment: (req.body.offerNotes || '').trim() || null,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json(shapeRow(fresh));
});

router.post('/offers/:id/accept', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (app.offerStatus !== 'Offer Released') {
    return res.status(409).json({ error: `Only a released offer can be accepted — this one is ${app.offerStatus || 'Not Issued'}` });
  }
  await prisma.application.update({
    where: { id: app.id },
    data: {
      stage: 'OFFER_ACCEPTED',
      offerStatus: 'Offer Accepted',
      offerAcceptedAt: new Date(),
      documentsStatus: app.documentsStatus === 'Verified' ? 'Verified' : (app.documentsStatus || 'Pending'),
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Offer accepted', entity: 'Application', entityId: app.id,
    fromValue: 'Offer Released', toValue: 'Offer Accepted',
  });
  await recordWorkflowMove({ user: req.user, existing: app, toStage: 'OFFER_ACCEPTED', action: 'Offer accepted' });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json(shapeRow(fresh));
});

// Declining an offer does NOT silently reject the candidate — it records the
// decline and leaves the pipeline where a human can decide what happens next.
router.post('/offers/:id/decline', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required' });
  await prisma.application.update({
    where: { id: app.id },
    data: { offerStatus: 'Offer Declined', offerNotes: reason },
  });
  await logAudit({
    userId: req.user.id, action: `Offer declined — ${reason}`, entity: 'Application',
    entityId: app.id, fromValue: app.offerStatus || 'Not Issued', toValue: 'Offer Declined',
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json(shapeRow(fresh));
});

router.post('/offers/:id/documents', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  const status = req.body.documentsStatus;
  if (!DOCUMENT_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown document status' });
  if (app.offerStatus !== 'Offer Accepted' && status !== 'Pending') {
    return res.status(409).json({ error: 'Documents are collected after the offer is accepted' });
  }
  await prisma.application.update({ where: { id: app.id }, data: { documentsStatus: status } });
  await logAudit({
    userId: req.user.id, action: `Joining documents ${status.toLowerCase()}`, entity: 'Application',
    entityId: app.id, fromValue: app.documentsStatus || 'Pending', toValue: status,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json(shapeRow(fresh));
});

// ---------------------------------------------------------------------------
// Joining
//   Documents -> Joining Scheduled -> Joined
// and, for a client placement only, straight on into Accounts:
//   Candidate Joined -> Billing Pending -> Invoice -> Receivable
// ---------------------------------------------------------------------------
router.get('/joining', requirePerm('ats', 'interviews', 'Joining', 'view'), async (req, res) => {
  // §35 — two ways in. A CLIENT PLACEMENT comes straight from Selected (Client
  // Joining: the client confirms the date, then Accounts invoices). A TeamLink
  // INTERNAL HIRE comes from Offer Accepted (its offer lives on Offers).
  // Both kinds of hire reach Joining from Offer Accepted (the actual
  // workflow). A client placement then runs its guarantee period and hands
  // over to Accounts; an internal hire goes on to HRMS.
  const rows = await listScoped(req, { stage: { in: ['OFFER_ACCEPTED', 'JOINED', 'HIRED'] } });
  const clientIds = [...new Set(rows.map((r) => r.requirement.client && r.requirement.client.id).filter(Boolean))];
  const terms = clientIds.length
    ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, guaranteePeriod: true } })
    : [];
  const periodOf = new Map(terms.map((c) => [c.id, c.guaranteePeriod]));
  // The invoice raised on joining, so the Joining table can show the Accounts
  // hand-off rather than claiming it happened.
  const invoices = await prisma.invoice.findMany({
    where: { candidateId: { in: rows.map((r) => r.candidate.id) } },
  });
  const withInvoice = rows.map((r) => {
    const inv = invoices.find((i) => i.candidateId === r.candidate.id && i.requirementId === r.requirement.id);
    const period = r.requirement.client ? periodOf.get(r.requirement.client.id) : null;
    const gDays = r.hiringType === INTERNAL_HIRE ? null : guaranteeDaysOf(period);
    const gEnd = ['JOINED', 'HIRED'].includes(r.stage) ? guaranteeEndOf(r, gDays) : null;
    return {
      ...r,
      guaranteePeriod: r.hiringType === INTERNAL_HIRE ? null : (period || null),
      guaranteeDays: gDays,
      guaranteeEnds: gEnd ? gEnd.toISOString().slice(0, 10) : null,
      inGuarantee: !!gEnd && gEnd >= new Date() && ![JOINING_REPLACEMENT_DUE, JOINING_REPLACED, JOINING_LEFT_AFTER_GUARANTEE].includes(r.joiningStatus),
      invoice: inv
        ? {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amount: inv.amount,
          gst: inv.gst,
          tds: inv.tds,
          // amount + GST - TDS — utils/accounts.js invoiceTotal, the one
          // definition of what the client actually transfers.
          total: Math.round((Number(inv.amount) + Number(inv.gst) - Number(inv.tds)) * 100) / 100,
          feePercent: inv.feePercent,
          gstPercent: inv.gstPercent,
          tdsPercent: inv.tdsPercent,
          offeredCtc: inv.offeredCtc,
          invoiceDate: inv.invoiceDate,
          dueDate: inv.dueDate,
          status: inv.status,
        }
        : null,
    };
  });
  res.json({ rows: withInvoice, filterOptions: filterOptionsFor(rows) });
});

router.post('/joining/:id/schedule', requirePerm('ats', 'interviews', 'Joining', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  const internal = isInternalHire(app, app.requirement);
  if (internal) {
    // Internal hire: our own offer, accepted, documents verified.
    if (app.offerStatus !== 'Offer Accepted') {
      return res.status(409).json({ error: 'A joining date is set once the offer is accepted' });
    }
    if (app.documentsStatus !== 'Verified') {
      return res.status(409).json({ error: 'Documents must be verified before a joining date is set' });
    }
  } else if (app.stage !== 'OFFER_ACCEPTED') {
    // Client placement: Selected → Offer (the client's, recorded) → Offer
    // Accepted → Joining (the actual workflow, 2026-09-29).
    return res.status(409).json({ error: `Client joining follows Offer Accepted — this candidate is at ${stageLabel(app.stage)}. Record the client's offer on Offers first.` });
  }
  const joiningDate = req.body.joiningDate;
  if (!joiningDate || Number.isNaN(new Date(joiningDate).getTime())) {
    return res.status(400).json({ error: 'A valid joining date is required' });
  }
  await prisma.application.update({
    where: { id: app.id },
    data: {
      joiningDate,
      joiningStatus: 'Joining Scheduled',
      hiringType: hiringTypeOf(app, app.requirement),
      // The CTC the placement fee is calculated on (optional for a client
      // placement; the requirement's salary band is used when absent).
      ...(!internal && Number(req.body.offeredCtc) > 0 ? { offeredCtc: Number(req.body.offeredCtc) } : {}),
    },
  });
  await logAudit({
    userId: req.user.id, action: internal ? 'Joining scheduled' : 'Client joining scheduled', entity: 'Application', entityId: app.id,
    fromValue: app.joiningStatus || 'Not Scheduled', toValue: `Joining Scheduled — ${joiningDate}`,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json(shapeRow(fresh));
});

router.post('/joining/:id/joined', requirePerm('ats', 'interviews', 'Joining', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (app.joiningStatus !== 'Joining Scheduled') {
    return res.status(409).json({ error: 'Schedule the joining date before marking the candidate joined' });
  }
  const joinFrom = ['OFFER_ACCEPTED'];
  if (!joinFrom.includes(app.stage)) {
    return res.status(409).json({ error: `This candidate is at ${stageLabel(app.stage)} — they can't be marked joined from here` });
  }
  const application = await prisma.application.update({
    where: { id: app.id },
    data: { stage: 'JOINED', joinedAt: new Date() },
  });
  // ONE joining path, shared with the pipeline's own stage move: it forks on
  // hiring type and raises an invoice for a client placement only.
  const invoice = await onApplicationJoined({
    application, existing: app, userId: req.user.id,
  });
  await logAudit({
    userId: req.user.id,
    action: isInternalHire(app, app.requirement)
      ? 'Internal hire joined TeamLink'
      : 'Candidate joined client — billing raised',
    entity: 'Application', entityId: app.id, fromValue: stageLabel(app.stage), toValue: 'Joined',
  });
  await recordWorkflowMove({
    user: req.user, existing: app, application, toStage: 'JOINED',
    action: isInternalHire(app, app.requirement) ? 'Joined TeamLink (internal hire)' : 'Client joining confirmed — handed to Accounts',
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json({
    ...shapeRow(fresh),
    invoiceId: invoice ? invoice.id : null,
    message: invoice
      ? 'Joined. Invoice raised against the client — Accounts picks it up as a receivable.'
      : 'Joined TeamLink as an internal hire — no client invoice. Create the HRMS employee record next.',
  });
});

// ---------------------------------------------------------------------------
// Guarantee / Replacement (the actual workflow, 2026-09-29)
//   Joining -> Guarantee period (the client's agreed terms, e.g. "3 Months")
//   -> left INSIDE it: Replacement Due -> Replaced
//   -> left AFTER it:  Left after Guarantee (no replacement owed)
// Stored on the existing Application.joiningStatus string; the move is also a
// Pipeline History row and an audit row. Client placements only.
// ---------------------------------------------------------------------------
// A Pipeline History row that records a guarantee event without a stage move
// (utils/stageEvents recordWorkflowMove only writes on a stage CHANGE).
async function guaranteeEvent(user, app, action, comment) {
  const r = app.requirement || {};
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: app.id,
      candidateId: app.candidateId,
      fromStage: app.stage,
      toStage: app.stage,
      action,
      comment: comment ? String(comment).slice(0, 2000) : null,
      actorUserId: user.id,
      actorName: user.name,
      actorRole: user.atsRole || user.role,
      actorSide: 'Internal',
      requirementId: app.requirementId,
      requirementTitle: r.title || null,
      clientId: r.clientId || null,
      clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
    },
  });
}

router.post('/joining/:id/left', requirePerm('ats', 'interviews', 'Joining', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (isInternalHire(app, app.requirement)) {
    return res.status(409).json({ error: 'An internal hire who leaves is an HRMS exit (resignation), not a client replacement.' });
  }
  if (!['JOINED', 'HIRED'].includes(app.stage)) {
    return res.status(409).json({ error: `Only a joined placement can leave — this candidate is at ${stageLabel(app.stage)}` });
  }
  if ([JOINING_REPLACEMENT_DUE, JOINING_REPLACED, JOINING_LEFT_AFTER_GUARANTEE].includes(app.joiningStatus)) {
    return res.status(409).json({ error: `Already recorded: ${app.joiningStatus}` });
  }
  const leftOn = String(req.body.leftOn || new Date().toISOString().slice(0, 10)).slice(0, 10);
  if (Number.isNaN(new Date(leftOn).getTime())) return res.status(400).json({ error: 'The date the candidate left is not a date' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Say why the candidate left' });
  const gDays = guaranteeDaysOf(app.requirement.client && app.requirement.client.guaranteePeriod);
  const end = guaranteeEndOf(app, gDays);
  const inside = !!end && new Date(leftOn) <= end;
  const status = inside ? JOINING_REPLACEMENT_DUE : JOINING_LEFT_AFTER_GUARANTEE;
  await prisma.application.update({ where: { id: app.id }, data: { joiningStatus: status } });
  const what = inside
    ? `Left within the guarantee (${app.requirement.client.guaranteePeriod}, to ${end.toISOString().slice(0, 10)}) — replacement due`
    : `Left after the guarantee${end ? ` (ended ${end.toISOString().slice(0, 10)})` : ''} — no replacement owed`;
  await guaranteeEvent(req.user, app, what, `Left on ${leftOn}: ${reason}`);
  await logAudit({
    userId: req.user.id, action: 'Placement left', entity: 'Application', entityId: app.id,
    fromValue: app.joiningStatus || 'Joined', toValue: status, reason,
  });
  if (inside) {
    await notifyUsers([app.requirement.recruiterId, app.requirement.bdeId, app.requirement.tlId], {
      title: `Replacement due: ${app.candidate.name}`,
      message: `${app.requirement.title} — ${app.requirement.client.name}. Left ${leftOn}, inside the ${app.requirement.client.guaranteePeriod} guarantee.`,
      exceptUserId: req.user.id,
    });
  }
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json({ ...shapeRow(fresh), guaranteeEnds: end ? end.toISOString().slice(0, 10) : null, replacementDue: inside });
});

router.post('/joining/:id/replaced', requirePerm('ats', 'interviews', 'Joining', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (app.joiningStatus !== JOINING_REPLACEMENT_DUE) {
    return res.status(409).json({ error: 'Only a placement marked Replacement Due can be closed as replaced' });
  }
  const note = String(req.body.note || '').trim();
  await prisma.application.update({ where: { id: app.id }, data: { joiningStatus: JOINING_REPLACED } });
  await guaranteeEvent(req.user, app, 'Replacement provided', note || null);
  await logAudit({
    userId: req.user.id, action: 'Replacement provided', entity: 'Application', entityId: app.id,
    fromValue: JOINING_REPLACEMENT_DUE, toValue: JOINING_REPLACED, reason: note || undefined,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json(shapeRow(fresh));
});

// ---------------------------------------------------------------------------
// Internal Hiring
//   Selected -> Internal Offer -> Accepted -> Hired -> HRMS Employee Creation
// This is the ONLY route in the app that turns an ATS candidate into an HRMS
// employee, and it refuses anything that is not a TeamLink internal hire.
// ---------------------------------------------------------------------------
router.get('/internal-hiring', requirePerm('ats', 'interviews', 'Internal Hiring', 'view'), async (req, res) => {
  const all = await listScoped(req, {});
  const rows = all.filter((r) => r.hiringType === INTERNAL_HIRE);
  const employees = await prisma.employee.findMany({
    where: { id: { in: rows.map((r) => r.hrmsEmployeeId).filter(Boolean) } },
  });
  res.json({
    rows: rows.map((r) => {
      const emp = employees.find((e) => e.id === r.hrmsEmployeeId);
      return { ...r, employee: emp ? { id: emp.id, employeeCode: emp.employeeCode, name: emp.name, department: emp.department, designation: emp.designation, employmentStatus: emp.employmentStatus } : null };
    }),
    filterOptions: filterOptionsFor(rows),
  });
});

router.post('/internal-hiring/:id/create-employee', requirePerm('ats', 'interviews', 'Internal Hiring', 'approve'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (!isInternalHire(app, app.requirement)) {
    return res.status(409).json({
      error: 'This is a client placement — a placed candidate joins the CLIENT and never becomes a TeamLink employee.',
    });
  }
  if (app.stage !== 'JOINED' && app.stage !== 'HIRED') {
    return res.status(409).json({ error: 'An internal hire becomes an employee once they have joined' });
  }
  const employee = await createHrmsEmployee({
    application: app, candidate: app.candidate, requirement: app.requirement, userId: req.user.id,
  });
  const hired = await prisma.application.update({ where: { id: app.id }, data: { stage: 'HIRED' } });
  await recordWorkflowMove({
    user: req.user, existing: app, application: hired, toStage: 'HIRED',
    action: `Hired — HRMS employee ${employee ? employee.employeeCode : ''} created`.trim(),
  });
  await logAudit({
    userId: req.user.id, action: 'Internal hire moved to Hired (HRMS)', entity: 'Application',
    entityId: app.id, fromValue: stageLabel(app.stage), toValue: 'Hired',
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json({
    ...shapeRow(fresh),
    employee: employee
      ? { id: employee.id, employeeCode: employee.employeeCode, name: employee.name, department: employee.department, designation: employee.designation }
      : null,
    message: employee ? `HRMS employee ${employee.employeeCode} created. No invoice — an internal hire is not billable.` : 'No employee created.',
  });
});

// Hiring type is normally inherited from the requirement. A lead can correct
// it while the candidate is still pre-offer; after an offer is out, the
// downstream (invoice vs HRMS) is already committed and it is frozen.
router.patch('/applications/:id/hiring-type', requirePerm('ats', 'interviews', 'Internal Hiring', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  const hiringType = req.body.hiringType;
  if (!HIRING_TYPES.includes(hiringType)) return res.status(400).json({ error: 'Unknown hiring type' });
  if (['OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(app.stage)) {
    return res.status(409).json({ error: 'Hiring type is fixed once an offer has been released' });
  }
  await prisma.application.update({
    where: { id: app.id },
    data: {
      hiringType,
      billingStatus: hiringType === INTERNAL_HIRE ? 'Not Applicable' : 'Billing Pending',
    },
  });
  await logAudit({
    userId: req.user.id, action: `Hiring type set to ${hiringType}`, entity: 'Application',
    entityId: app.id, fromValue: hiringTypeOf(app, app.requirement), toValue: hiringType,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json(shapeRow(fresh));
});

module.exports = router;
