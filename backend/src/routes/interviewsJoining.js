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
const { applicationWhere, atsScopeOf: scopeOf, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const {
  interviewStatusLabel, stageLabel, INTERVIEW_RECOMMENDATIONS, normalizeRecommendation,
} = require('../utils/atsVocab');
const {
  INTERNAL_HIRE, HIRING_TYPES, OFFER_STATUSES, DOCUMENT_STATUSES,
  hiringTypeOf, isInternalHire, createHrmsEmployee, onApplicationJoined,
  stageAllowedForHiringType, dateYearProblem,
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
    round: app.interviewRound || 1,
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
    offerAcceptedAt: app.offerAcceptedAt || null,
    joinedAt: app.joinedAt || null,
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
    // AND, never a spread: a scope that is itself an OR (a seat-scoped lead)
    // must not be overwritten by a list's own OR.
    where: { AND: [applicationWhere(req.user), where] },
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
    OR: [
      { interviewStatus: { in: ['COMPLETED', 'PENDING_FEEDBACK', 'FEEDBACK_SUBMITTED'] } },
      // A booked slot whose time has passed is owed feedback too, even when
      // nobody pressed Start / Complete (change list §11: "required after the
      // interview").
      { interviewStatus: { in: ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'] }, interviewAt: { lt: new Date() } },
    ],
  });
  // B4: each row's panel (current round) with every person's own scorecard.
  // eslint-disable-next-line global-require
  const panels = await require('../utils/interviewPanel').panelsFor(rows.map((r) => ({ id: r.id, interviewRound: r.round, interviewer: r.interviewer, interviewFeedbacks: r.internalFeedback ? [{ ...r.internalFeedback, updatedAt: r.internalFeedback.createdAt }] : [] })));
  rows.forEach((r) => { r.panel = panels.get(r.id) || []; });
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
  // The short form (rating · strengths · concerns · decision), folded into
  // the same record — utils/shortFeedback.js.
  // eslint-disable-next-line global-require
  const SF = require('../utils/shortFeedback');
  const short = SF.fromShortForm(req.body);
  const shortProblem = SF.shortFormProblem(short);
  if (shortProblem) return res.status(400).json({ error: shortProblem });
  if (short) { req.body.overall = short.overall; Object.assign(req.body, short.ratings); }
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
  // FROM HOLD the decision follows the same step-order rule as every other
  // move (e2e gap 15): someone put on hold at "Check by team lead" can't be
  // marked Selected from here. Super Admin / Admin stay exempt.
  // eslint-disable-next-line global-require
  if (app.stage === 'HOLD' && decision !== 'Rejected' && !require('../utils/permissions').stageGlobal(req.user)) {
    const parked = await prisma.applicationStageEvent.findFirst({
      where: { applicationId: app.id, toStage: 'HOLD' }, orderBy: { createdAt: 'desc' }, select: { fromStage: true },
    });
    // eslint-disable-next-line global-require
    const chain = require('../utils/atsVocab').stageMoveProblem('HOLD', DECISION_STAGE[decision], {
      internal: isInternalHire(app, app.requirement), resumeFrom: parked ? parked.fromStage : null,
    });
    if (chain) return res.status(409).json({ error: chain });
  }
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
    // Change list §10/§11 (2026-10-03): the reject from Interview Feedback is
    // the SAME reject as everywhere else — the shared dialog's body (whose
    // decision · Not suitable / Do not use · reason · note · the client's own
    // words) goes through the pipeline's own reject (routes/applications.js
    // applyStageMove), which writes the rejection record, the "Do not use"
    // approval request and the candidate message. A note is required here too.
    if (!String(req.body.reasonDetail || '').trim()) {
      return res.status(400).json({ error: 'Add a short note saying what happened.' });
    }
    // eslint-disable-next-line global-require
    const { applyStageMove } = require('./applications');
    const out = await applyStageMove(req.user, app.id, {
      stage: 'REJECTED',
      rejectedBy: rejectionSide,
      rejectKind: req.body.rejectKind === 'do_not_use' ? 'do_not_use' : 'not_suitable',
      reasonCategory: String(req.body.reasonCategory || '').trim(),
      reasonDetail: String(req.body.reasonDetail || '').trim(),
      comment: String(req.body.comment || '').trim() || undefined,
    });
    if (out.status !== 200) return res.status(out.status).json(out.body);
    await logAudit({
      userId: req.user.id, action: 'Interview decision — Rejected', entity: 'Application',
      entityId: app.id, fromValue: stageLabel(app.stage), toValue: stageLabel('REJECTED'),
    });
    const rejected = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
    return res.json(shapeRow(rejected));
  }
  // The stage and its history row are written TOGETHER (e2e gap 16): a crash
  // between the two used to leave Selected with no history row.
  const toStage = DECISION_STAGE[decision];
  const moveInfo = {
    user: req.user,
    existing: app,
    toStage,
    action: `Interview decision — ${decision}`,
    comment: req.body.comment,
    reasonCategory: req.body.reasonCategory,
    reasonDetail: req.body.reasonDetail,
    rejectionSide,
  };
  const changesStage = app.stage !== toStage;
  // eslint-disable-next-line global-require
  const eventData = changesStage ? await require('../utils/stageEvents').stageEventData(moveInfo) : null;
  const writes = [
    prisma.application.update({
      where: { id: app.id },
      data: {
        stage: toStage,
        hiringType: hiringTypeOf(app, app.requirement),
        ...(decision === 'Selected' ? { offerStatus: app.offerStatus || 'Not Issued' } : {}),
      },
    }),
  ];
  if (eventData) writes.push(prisma.applicationStageEvent.create({ data: eventData }));
  const [updated] = await prisma.$transaction(writes);
  await logAudit({
    userId: req.user.id, action: `Interview decision — ${decision}`, entity: 'Application',
    entityId: app.id, fromValue: stageLabel(app.stage), toValue: stageLabel(updated.stage),
  });
  await recordWorkflowMove({ ...moveInfo, application: updated, skipEvent: true });
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
  // B3: an offer whose time is up is Expired before the list is read.
  // eslint-disable-next-line global-require
  const OL = require('../utils/offerLink');
  await OL.expireDue().catch(() => 0);
  const rows = await listScoped(req, { stage: { in: OFFER_STAGES } });
  // The current letter version per row (v2, expires, opened, signed).
  // Only rows that ever had a letter sent can have a version.
  const offered = rows.filter((r) => r.offerStatus && r.offerStatus !== 'Not Issued').map((r) => r.id);
  if (OL.ready() && offered.length) {
    const vs = await prisma.offerVersion.findMany({
      where: { applicationId: { in: offered } },
      select: { applicationId: true, version: true, status: true, expiresAt: true, viewedAt: true, signedAt: true, pdfFile: true },
      orderBy: { version: 'desc' },
    });
    const cur = new Map();
    vs.forEach((v) => { if (!cur.has(v.applicationId)) cur.set(v.applicationId, v); });
    rows.forEach((r) => {
      const v = cur.get(r.id);
      r.offerVersion = v ? { version: v.version, status: v.status, expiresAt: v.expiresAt, viewedAt: v.viewedAt, signedAt: v.signedAt, hasPdf: !!v.pdfFile } : null;
    });
  }
  const offerSettings = await OL.loadSettings();
  // eslint-disable-next-line global-require
  const candidateEmailsOn = await require('../utils/interviewNotices').candidateEmailsOn();
  res.json({ rows, filterOptions: filterOptionsFor(rows), offerStatuses: [...OFFER_STATUSES, OL.OFFER_EXPIRED], documentStatuses: DOCUMENT_STATUSES, offerSettings, candidateEmailsOn });
});

// B3 (2026-10-06): offer versions, expiry and the candidate's signing link —
// the routes live in routes/offerStaffRoutes.js (mounted here, same scope).
require('./offerStaffRoutes')(router, { loadScoped });

// ---------------------------------------------------------------------------
// OFFER LETTER — template → approval → sent → the candidate accepts / declines
// (change list §12, 2026-10-03). No schema change:
//   Prepare     (Offers / edit)     offerStatus "Offer being prepared", the CTC,
//                                   offer date and proposed joining date saved;
//                                   the job's TL / STL is asked to approve.
//                                   (The candidate portal already reads
//                                   "Offer being prepared" for a Selected row.)
//   Approve & send (Offers / approve) the letter is filled from the template,
//                                   emailed through the candidate message queue
//                                   and shown on the candidate's portal page,
//                                   whose existing Accept / Decline buttons
//                                   answer it (routes/portal.js).
//   Send back   (Offers / approve)  back to "Not Issued" with the reason.
// The template is one AppSetting row ("offer-letter-template"), Admin-edited.
// ---------------------------------------------------------------------------
const OFFER_PREPARED = 'Offer being prepared';
const TEMPLATE_KEY = 'offer-letter-template';
const DEFAULT_TEMPLATE = [
  'Dear {{name}},',
  '',
  'We are happy to offer you the job of {{job}} at {{company}}.',
  '',
  'Annual CTC: {{ctc}}',
  'Joining date: {{joiningDate}}',
  'Place of work: {{location}}',
  '',
  '{{notes}}',
  '',
  'Please accept (sign on the offer link) or decline this offer, or tell your recruiter, by {{replyBy}}. After that date the offer expires.',
  '',
  'Best wishes,',
  '{{sender}}',
  'TeamLink',
].join('\n');

async function offerTemplate() {
  const row = await prisma.appSetting.findUnique({ where: { key: TEMPLATE_KEY } }).catch(() => null);
  try {
    const v = row ? JSON.parse(row.value) : null;
    if (v && typeof v.text === 'string' && v.text.trim()) return { text: v.text, updatedByName: row.updatedByName, updatedAt: row.updatedAt, custom: true };
  } catch { /* fall through to the default */ }
  return { text: DEFAULT_TEMPLATE, custom: false };
}

const inr = (n) => (Number(n) > 0 ? `₹${Math.round(Number(n)).toLocaleString('en-IN')}` : 'to be confirmed');
function fillLetter(text, app, sender, extra = {}) {
  const r = app.requirement || {};
  const plusDays = (d, n) => { const x = d ? new Date(d) : new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const tokens = {
    name: app.candidate ? app.candidate.name : '',
    job: r.title || '',
    company: r.internal ? 'TeamLink' : ((r.client && r.client.name) || ''),
    ctc: inr(app.offeredCtc),
    joiningDate: app.joiningDate || 'to be confirmed',
    location: r.location || (app.candidate && app.candidate.location) || 'to be confirmed',
    notes: app.offerNotes || '',
    offerDate: app.offerDate || new Date().toISOString().slice(0, 10),
    replyBy: extra.replyBy || plusDays(app.offerDate, 3),
    sender: (sender && sender.name) || 'Your recruiter',
  };
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (tokens[k] == null ? '' : String(tokens[k])))
    .replace(/\n{3,}/g, '\n\n').trim();
}

router.get('/offers/letter-template', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
  const t = await offerTemplate();
  res.json({ ...t, tokens: ['name', 'job', 'company', 'ctc', 'joiningDate', 'location', 'notes', 'offerDate', 'replyBy', 'sender'], canEdit: ['SUPER_ADMIN', 'ADMIN'].includes(req.user.role) });
});

router.put('/offers/letter-template', requirePerm('ats', 'interviews', 'Offers', 'approve'), async (req, res) => {
  if (!['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Only an Admin can change the offer letter template.' });
  const text = String(req.body.text || '').trim();
  if (text.length < 20) return res.status(400).json({ error: 'The letter is too short — write at least a couple of lines.' });
  if (text.length > 8000) return res.status(400).json({ error: 'The letter is too long (8,000 characters at most).' });
  const before = await offerTemplate();
  await prisma.appSetting.upsert({
    where: { key: TEMPLATE_KEY },
    create: { key: TEMPLATE_KEY, value: JSON.stringify({ text }), updatedById: req.user.id, updatedByName: req.user.name },
    update: { value: JSON.stringify({ text }), updatedById: req.user.id, updatedByName: req.user.name },
  });
  await logAudit({ userId: req.user.id, action: 'Offer letter template changed', entity: 'AppSetting', entityId: TEMPLATE_KEY, fromValue: before.text.slice(0, 500), toValue: text.slice(0, 500) });
  res.json({ ...(await offerTemplate()), message: 'Saved. New offer letters use this text.' });
});

// The letter: the one that was sent, else a preview from the template.
router.get('/offers/:id/letter', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  const sent = await prisma.candidateMessage.findFirst({
    where: { applicationId: app.id, template: 'OFFER_LETTER' }, orderBy: { createdAt: 'desc' },
  });
  if (sent && app.offerStatus !== OFFER_PREPARED && app.stage !== 'SELECTED') {
    return res.json({ text: sent.body, sent: true, sentAt: sent.createdAt, status: sent.status, recipient: sent.recipient });
  }
  const t = await offerTemplate();
  res.json({ text: fillLetter(t.text, app, req.user), sent: false });
});

router.post('/offers/:id/prepare', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  // B3: "Offer again" after an expired offer, or "Change offer" on one still
  // waiting for the candidate (it becomes the next version on approval).
  const reissue = app.stage === 'OFFER' && ['Offer Released', 'Offer Expired'].includes(app.offerStatus);
  if (app.stage !== 'SELECTED' && app.offerStatus !== 'Offer Declined' && !reissue) {
    return res.status(409).json({ error: `An offer comes after Selected — this candidate is at ${stageLabel(app.stage)}.` });
  }
  const wrongBranch = stageAllowedForHiringType('OFFER', app, app.requirement);
  if (wrongBranch) return res.status(409).json({ error: wrongBranch });
  const ctc = Number(req.body.offeredCtc);
  if (!(ctc > 0)) return res.status(400).json({ error: 'Write the yearly CTC in rupees, e.g. 450000.' });
  const offerDate = String(req.body.offerDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const joiningDate = req.body.joiningDate ? String(req.body.joiningDate).slice(0, 10) : null;
  if (joiningDate && Number.isNaN(new Date(joiningDate).getTime())) return res.status(400).json({ error: 'The joining date is not a date.' });
  // B9.10: a year like 2203 or 1954 is a slip, not a plan.
  const yearNo = dateYearProblem(joiningDate, 'joining date') || dateYearProblem(offerDate, 'offer date');
  if (yearNo) return res.status(400).json({ error: yearNo });
  await prisma.application.update({
    where: { id: app.id },
    data: {
      offerStatus: OFFER_PREPARED,
      offeredCtc: ctc,
      offerDate,
      offerNotes: String(req.body.offerNotes || '').trim().slice(0, 2000) || null,
      ...(joiningDate ? { joiningDate } : {}),
      hiringType: hiringTypeOf(app, app.requirement),
    },
  });
  await logAudit({ userId: req.user.id, action: 'Offer prepared — waiting for approval', entity: 'Application', entityId: app.id, fromValue: app.offerStatus || 'Not Issued', toValue: OFFER_PREPARED });
  // A changed offer withdraws the one the candidate holds: its link stops now.
  if (app.offerStatus === 'Offer Released') {
    // eslint-disable-next-line global-require
    const OL = require('../utils/offerLink');
    const cur = await OL.currentVersion(app.id);
    if (cur && cur.status === 'Sent') {
      await prisma.offerVersion.update({ where: { id: cur.id }, data: { status: 'Replaced', linkStoppedAt: new Date() } });
      await logAudit({ userId: req.user.id, action: `Offer v${cur.version} withdrawn — a changed offer is being prepared`, entity: 'OfferVersion', entityId: cur.id, fromValue: 'Sent', toValue: 'Replaced' });
    }
  }
  await guaranteeEvent(req.user, app, 'Offer prepared — waiting for approval', `CTC ${inr(ctc)}${joiningDate ? `, joining ${joiningDate}` : ''}`);
  // Who approves: the job's TL / STL (the same people the permission matrix
  // gives "approve" to). Without a TL on the job, nobody is guessed — the
  // offer waits on the Offers screen for any approver.
  const r = app.requirement || {};
  await notifyUsers([r.tlId, r.stlId], {
    title: `✍️ Offer to approve: ${app.candidate.name}`,
    message: `${r.title} — ${r.internal ? 'TeamLink' : (r.client && r.client.name) || ''}. CTC ${inr(ctc)}. Open Offers → Approve & send.`,
    exceptUserId: req.user.id,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json({ ...shapeRow(fresh), message: `Offer for ${app.candidate.name} is ready. Waiting for approval.` });
});

router.post('/offers/:id/send-back', requirePerm('ats', 'interviews', 'Offers', 'approve'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (app.offerStatus !== OFFER_PREPARED) return res.status(409).json({ error: 'This offer is not waiting for approval.' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Say what to change before it can be approved.' });
  await prisma.application.update({ where: { id: app.id }, data: { offerStatus: 'Not Issued' } });
  await logAudit({ userId: req.user.id, action: `Offer sent back — ${reason}`, entity: 'Application', entityId: app.id, fromValue: OFFER_PREPARED, toValue: 'Not Issued', reason });
  await guaranteeEvent(req.user, app, 'Offer sent back for changes', reason);
  const r = app.requirement || {};
  await notifyUsers([r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim())], {
    title: `Offer sent back: ${app.candidate.name}`, message: `${req.user.name}: ${reason}`, exceptUserId: req.user.id,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json({ ...shapeRow(fresh), message: 'Sent back to the recruiter with your note.' });
});

// Approve & send. Also the old "Release offer" call, which now needs the
// approver's right too — an offer never reaches a candidate unapproved.
async function approveAndSend(req, res) {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (app.stage !== 'SELECTED' && app.offerStatus !== 'Offer Declined' && !(app.stage === 'OFFER' && [OFFER_PREPARED, 'Offer Expired'].includes(app.offerStatus))) {
    return res.status(409).json({ error: `An offer follows Selected — this candidate is at ${stageLabel(app.stage)}` });
  }
  // §35 — the same hiring-type rule the pipeline enforces. This route used to
  // skip it, so a client placement could be walked through Offer here.
  const wrongBranch = stageAllowedForHiringType('OFFER', app, app.requirement);
  if (wrongBranch) return res.status(409).json({ error: wrongBranch });
  const ctc = Number(req.body.offeredCtc != null && req.body.offeredCtc !== '' ? req.body.offeredCtc : app.offeredCtc);
  if (!(ctc > 0)) return res.status(400).json({ error: 'An offered CTC is required' });
  const offerDate = req.body.offerDate || app.offerDate || new Date().toISOString().slice(0, 10);
  const offerNotes = req.body.offerNotes != null ? (String(req.body.offerNotes).trim() || null) : (app.offerNotes || null);
  const hiringType = hiringTypeOf(app, app.requirement);
  // B9.10: a year like 2203 or 1954 is a slip, not a plan.
  const relYearNo = dateYearProblem(req.body.joiningDate ? String(req.body.joiningDate).slice(0, 10) : null, 'joining date') || dateYearProblem(offerDate, 'offer date');
  if (relYearNo) return res.status(400).json({ error: relYearNo });
  await prisma.application.update({
    where: { id: app.id },
    data: {
      stage: 'OFFER',
      hiringType,
      offerStatus: 'Offer Released',
      offerDate,
      offeredCtc: ctc,
      offerNotes,
      ...(req.body.joiningDate ? { joiningDate: String(req.body.joiningDate).slice(0, 10) } : {}),
      documentsStatus: app.documentsStatus || 'Pending',
      joiningStatus: app.joiningStatus || 'Not Scheduled',
      billingStatus: hiringType === INTERNAL_HIRE ? 'Not Applicable' : 'Billing Pending',
    },
  });
  // The letter, filled from the template and sent to the candidate.
  let letter = null;
  let offerLinkInfo = null;
  try {
    const sentApp = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
    const t = await offerTemplate();
    // B3: the letter is version N of this offer, with an expiry and the
    // candidate's own signing link (utils/offerLink.js).
    // eslint-disable-next-line global-require
    const OL = require('../utils/offerLink');
    const { expiryDays } = await OL.loadSettings();
    const replyBy = new Date(Date.now() + expiryDays * 86400000 + 330 * 60000).toISOString().slice(0, 10);
    const text = fillLetter(t.text, sentApp, req.user, { replyBy });
    const made = await OL.createVersion(sentApp, { letterText: text, actor: req.user }).catch((e) => { console.error('[offers] version:', e.message); return null; }); // eslint-disable-line no-console
    offerLinkInfo = made ? { version: made.version.version, expiresAt: made.version.expiresAt, url: made.token ? OL.linkUrl(req, made.token) : null } : null;
    const body = offerLinkInfo && offerLinkInfo.url ? `${text}\n\nRead and sign your offer here: ${offerLinkInfo.url}` : text;
    // eslint-disable-next-line global-require
    const IN = require('../utils/interviewNotices');
    letter = await IN.queueCandidateEmail(sentApp, {
      template: 'OFFER_LETTER', label: 'Offer letter', subject: `Your offer — ${sentApp.requirement.title}`, body, actor: req.user,
    });
    const candUsers = await prisma.user.findMany({ where: { candidateId: app.candidateId, status: 'Active' }, select: { id: true } });
    await notifyUsers(candUsers.map((u) => u.id), {
      title: `🎉 You have an offer: ${sentApp.requirement.title}`,
      message: 'Open your TeamLink page to read it and press Accept or Decline.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[offers] could not send the letter:', err.message);
  }
  await logAudit({
    userId: req.user.id,
    action: hiringType === INTERNAL_HIRE ? 'Internal offer released' : 'Offer released',
    entity: 'Application', entityId: app.id, fromValue: stageLabel(app.stage), toValue: 'Offer',
  });
  await recordWorkflowMove({
    user: req.user, existing: app, toStage: 'OFFER',
    action: hiringType === INTERNAL_HIRE ? 'Internal offer approved and sent' : 'Offer approved and sent',
    comment: offerNotes,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json({
    ...shapeRow(fresh),
    letterId: letter ? letter.id : null,
    offerLink: offerLinkInfo,
    message: letter && letter.status === 'QUEUED'
      ? `Offer approved and sent to ${app.candidate.name}. Waiting for their answer.`
      // eslint-disable-next-line no-nested-ternary
      : `Offer approved. ${app.candidate.name} sees it on their TeamLink page${letter && letter.status === 'NOT_SENT_SWITCHED_OFF' ? ' (candidate emails are switched off, so no mail went out)' : letter && letter.recipient ? ' (email is not set up, so no mail went out)' : ' — there is no email on their record'}.`,
  });
}
router.post('/offers/:id/approve', requirePerm('ats', 'interviews', 'Offers', 'approve'), approveAndSend);
router.post('/offers/:id/release', requirePerm('ats', 'interviews', 'Offers', 'approve'), approveAndSend);
router.post('/offers/:id/accept', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (app.offerStatus !== 'Offer Released') {
    return res.status(409).json({ error: `Only a released offer can be accepted — this one is ${app.offerStatus || 'Not Issued'}` });
  }
  // eslint-disable-next-line global-require
  const OLa = require('../utils/offerLink');
  if (await OLa.isExpired(app.id)) {
    return res.status(409).json({ error: 'This offer has expired, so it cannot be accepted. Use "Offer again" to send a new version.' });
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
  await OLa.markCurrent(app.id, 'Accepted', { via: `recorded by ${req.user.name}` });
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
  // eslint-disable-next-line global-require
  await require('../utils/offerLink').markCurrent(app.id, 'Declined', { via: `recorded by ${req.user.name}`, reason });
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
  // Joining checklist (change list §12): the confirmation call is a Pipeline
  // History row ("Joining confirmation call — …"), read back here.
  const calls = rows.length
    ? await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: rows.map((r) => r.id) }, action: { startsWith: 'Joining confirmation call' } },
      select: { applicationId: true, createdAt: true, comment: true, actorName: true },
      orderBy: { createdAt: 'desc' },
    })
    : [];
  const callOf = new Map();
  calls.forEach((c) => { if (!callOf.has(c.applicationId)) callOf.set(c.applicationId, c); });
  const DAYMS = 86400000;
  const withInvoice = rows.map((r) => {
    const inv = invoices.find((i) => i.candidateId === r.candidate.id && i.requirementId === r.requirement.id);
    const period = r.requirement.client ? periodOf.get(r.requirement.client.id) : null;
    const gDays = r.hiringType === INTERNAL_HIRE ? null : guaranteeDaysOf(period);
    const gEnd = ['JOINED', 'HIRED'].includes(r.stage) ? guaranteeEndOf(r, gDays) : null;
    const call = callOf.get(r.id);
    const waitingSince = r.offerAcceptedAt || null;
    return {
      ...r,
      // "Waiting to join": accepted, not joined, not dropped — oldest first.
      waitingToJoin: r.stage === 'OFFER_ACCEPTED' && !['Joined', 'Dropped'].includes(r.joiningStatus),
      waitingSince,
      daysWaiting: waitingSince ? Math.max(0, Math.floor((Date.now() - new Date(waitingSince).getTime()) / DAYMS)) : null,
      call: call ? { at: call.createdAt, note: call.comment, by: call.actorName } : null,
      guaranteeDaysLeft: gEnd ? Math.ceil((gEnd.getTime() - Date.now()) / DAYMS) : null,
      // NOT "guaranteePeriod": that key marks a CLIENT row for
      // utils/clientRedact.js, which then cut this whole joining row down to
      // { id, status } for every login outside the client desk (recruiters
      // saw an empty Joining screen).
      guaranteeTerm: r.hiringType === INTERNAL_HIRE ? null : (period || null),
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
  // B9.10: a year like 2203 or 1954 is a slip, not a plan.
  const joinYearNo = dateYearProblem(joiningDate, 'joining date');
  if (joinYearNo) return res.status(400).json({ error: joinYearNo });
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
  // The Joined popup (ATS layout v3) now marks the joining HERE, through the
  // checklist (e2e gap 2): it may carry the final CTC and — for a login that
  // may see the client's terms — the commission % (utils/joining.js).
  let feeOverride = null;
  if (req.body && req.body.feePercent !== undefined && req.body.feePercent !== null && req.body.feePercent !== '') {
    const n = Number(req.body.feePercent);
    if (!Number.isFinite(n) || n <= 0 || n > 50) return res.status(400).json({ error: 'Commission must be a number between 0 and 50 %.' });
    // eslint-disable-next-line global-require
    feeOverride = require('../utils/joining').feeOverrideFor(req.user, n);
  }
  const finalCtc = req.body && Number(req.body.offeredCtc) > 0 && Number(req.body.offeredCtc) <= 100000000 ? Number(req.body.offeredCtc) : null;
  const application = await prisma.application.update({
    where: { id: app.id },
    data: { stage: 'JOINED', joinedAt: new Date(), ...(finalCtc ? { offeredCtc: finalCtc } : {}) },
  });
  // ONE joining path, shared with the pipeline's own stage move: it forks on
  // hiring type and raises an invoice for a client placement only.
  const invoice = await onApplicationJoined({
    application, existing: app, userId: req.user.id, ...(feeOverride != null ? { feePercent: feeOverride } : {}),
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
  // Internal hire with its HRMS employee made → Hired (e2e gap 9).
  // eslint-disable-next-line global-require
  if (isInternalHire(app, app.requirement)) await require('../utils/joining').finishInternalHire(app.id, req.user);
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  // "Rahul joined" — the small success message (change list §12), then what
  // happened next in one plain line.
  const first = String(app.candidate.name || 'The candidate').trim().split(/\s+/)[0];
  const internalHire = isInternalHire(app, app.requirement);
  const employee = internalHire && fresh.hrmsEmployeeId
    ? await prisma.employee.findUnique({ where: { id: fresh.hrmsEmployeeId }, select: { id: true, employeeCode: true } })
    : null;
  res.json({
    ...shapeRow(fresh),
    invoiceId: invoice ? invoice.id : null,
    employeeId: employee ? employee.id : null,
    joinedName: first,
    message: invoice
      ? `🎉 ${first} joined. The invoice for ${app.requirement.client ? app.requirement.client.name : 'the client'} is ready for Accounts.`
      : internalHire
        ? (employee ? `🎉 ${first} joined. HRMS employee ${employee.employeeCode} was created.` : `🎉 ${first} joined. The HRMS employee record could not be made — press "Create HRMS Employee".`)
        : `🎉 ${first} joined.`,
  });
});

// Joining checklist — the confirmation call (a Pipeline History row).
router.post('/joining/:id/call', requirePerm('ats', 'interviews', 'Joining', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (app.stage !== 'OFFER_ACCEPTED') {
    return res.status(409).json({ error: `The joining call is made while the person is waiting to join — they are at ${stageLabel(app.stage)}.` });
  }
  const outcome = String(req.body.outcome || 'Will join').trim();
  if (!['Will join', 'Not sure', 'Will not join'].includes(outcome)) return res.status(400).json({ error: 'Pick what the candidate said: Will join, Not sure or Will not join.' });
  const note = String(req.body.note || '').trim().slice(0, 1000);
  await guaranteeEvent(req.user, app, `Joining confirmation call — ${outcome}`, note || null);
  await logAudit({ userId: req.user.id, action: `Joining confirmation call — ${outcome}`, entity: 'Application', entityId: app.id, toValue: outcome, reason: note || undefined });
  if (outcome !== 'Will join') {
    const r = app.requirement || {};
    await notifyUsers([r.tlId, r.bdeId, r.recruiterId], {
      title: `🟠 Joining at risk: ${app.candidate.name}`,
      message: `${r.title} — confirmation call says "${outcome}"${note ? `: ${note}` : ''}.`,
      exceptUserId: req.user.id,
    });
  }
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json({ ...shapeRow(fresh), message: `Call saved — ${outcome}.` });
});

// Not joined: the person did not turn up / said no. Recorded as joiningStatus
// "Dropped" — not silently rejected; the row stays visible under "Did not join".
router.post('/joining/:id/not-joined', requirePerm('ats', 'interviews', 'Joining', 'edit'), async (req, res) => {
  const app = await loadScoped(req, res);
  if (!app) return;
  if (app.stage !== 'OFFER_ACCEPTED') {
    return res.status(409).json({ error: `Only someone waiting to join can be marked "did not join" — they are at ${stageLabel(app.stage)}.` });
  }
  if (app.joiningStatus === 'Dropped') return res.status(409).json({ error: 'Already marked as did not join.' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Say why they did not join.' });
  await prisma.application.update({ where: { id: app.id }, data: { joiningStatus: 'Dropped' } });
  await guaranteeEvent(req.user, app, 'Did not join', reason);
  // B7: a partner-sourced "did not join" cancels any payout draft and tells the partner.
  try { const PT = require('../utils/partners'); await PT.onLeft({ applicationId: app.id, inside: true, reason, user: req.user }); await PT.syncSubmission(app.id, { userId: req.user.id, note: reason }); } catch { /* optional */ } // eslint-disable-line global-require
  await logAudit({ userId: req.user.id, action: 'Did not join', entity: 'Application', entityId: app.id, fromValue: app.joiningStatus || 'Not Scheduled', toValue: 'Dropped', reason });
  const r = app.requirement || {};
  await notifyUsers([r.tlId, r.bdeId, r.recruiterId], {
    title: `🔴 Did not join: ${app.candidate.name}`,
    message: `${r.title} — ${r.internal ? 'TeamLink' : (r.client && r.client.name) || ''}. ${reason}`,
    exceptUserId: req.user.id,
  });
  const fresh = await prisma.application.findUnique({ where: { id: app.id }, include: FULL_INCLUDE });
  res.json({ ...shapeRow(fresh), message: `Saved — ${app.candidate.name} did not join.` });
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
  // B7: left inside the guarantee → the partner payout is cancelled (or a
  // clawback drafted when already paid); the partner is told either way.
  try { const PT = require('../utils/partners'); await PT.onLeft({ applicationId: app.id, inside, leftOn, reason, user: req.user }); await PT.syncSubmission(app.id, { userId: req.user.id, note: `Left on ${leftOn}: ${reason}` }); } catch { /* optional */ } // eslint-disable-line global-require
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

// ---------------------------------------------------------------------------
// BOOK AN INTERVIEW — "like booking a cab" (change list §11, 2026-10-03).
//   POST /ats/interviews/:id/book   (:id = the application)
//   { date: 'yyyy-mm-dd', time: 'hh:mm', mode: 'Online' | 'In Person',
//     meetingLink, location, interviewer }
// The first booking is the pipeline's own move to Interview Scheduled
// (routes/applications.js applyStageMove: permission, step order, history,
// follow-up and the candidate's message). A next round after feedback, a
// cancel or a no-show books a new slot on the same application. Then the
// candidate, the recruiter / TL / client manager and the client are told
// (utils/interviewNotices.js announceInterview).
// ---------------------------------------------------------------------------
const BOOK_MODES = { online: 'Online', 'in person': 'In Person', inperson: 'In Person', 'in-person': 'In Person' };

// Who can be booked: in your area, not decided, no live slot. Shortlisted by
// the client first (that is who an interview is for); ?q= finds anyone else
// by name, phone, email or job. At most 20 — the dialog is a picker, not a list.
router.get('/interviews/bookable', requirePerm('ats', 'interviews', 'Schedule Interview', 'create'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const base = {
    stage: { notIn: ['REJECTED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'HOLD'] },
    OR: [{ interviewStatus: null }, { interviewStatus: { notIn: ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'] } }],
  };
  const digits = q.replace(/\D/g, '');
  const match = q
    ? {
      OR: [
        { candidate: { name: { contains: q } } },
        { candidate: { email: { contains: q } } },
        ...(digits.length >= 4 ? [{ candidate: { phone: { contains: digits } } }] : []),
        { requirement: { title: { contains: q } } },
      ],
    }
    : { stage: 'CLIENT_SHORTLISTED' };
  const rows = await prisma.application.findMany({
    where: { AND: [applicationWhere(req.user), base, match] },
    select: {
      id: true, stage: true, interviewStatus: true, interviewRound: true, updatedAt: true,
      candidate: { select: { id: true, name: true, phone: true } },
      requirement: { select: { id: true, title: true, internal: true, client: { select: { name: true } } } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 40,
  });
  const rank = (a) => (a.stage === 'CLIENT_SHORTLISTED' ? 0 : 1);
  res.json({
    rows: rows.sort((a, b) => rank(a) - rank(b)).slice(0, 20).map((a) => ({
      id: a.id,
      candidate: { id: a.candidate.id, name: a.candidate.name },
      job: a.requirement.title,
      client: a.requirement.internal ? 'TeamLink' : (a.requirement.client && a.requirement.client.name) || '',
      stage: a.stage,
      stageLabel: stageLabel(a.stage),
      shortlisted: a.stage === 'CLIENT_SHORTLISTED',
      nextRound: ['FEEDBACK_SUBMITTED', 'CANCELLED', 'NO_SHOW'].includes(a.interviewStatus),
      // ROUND (layout v3): the round on record, and the round this booking
      // would be — +1 after feedback, the same round again after a cancel /
      // did-not-attend, 1 for a first interview.
      round: a.interviewStatus ? (a.interviewRound || 1) : null,
      suggestedRound: suggestedRoundOf(a),
    })),
  });
});
function suggestedRoundOf(a) {
  if (!a.interviewStatus) return 1;
  return (a.interviewRound || 1) + (a.interviewStatus === 'FEEDBACK_SUBMITTED' ? 1 : 0);
}
router.post('/interviews/:id/book', requirePerm('ats', 'interviews', 'Schedule Interview', 'create'), async (req, res) => {
  if (!req.user.caps || !req.user.caps.atsAct) return res.status(403).json({ error: "Booking interviews isn't part of your role." });
  const app = await loadScoped(req, res);
  if (!app) return;
  const b = req.body || {};
  const date = String(b.date || '').slice(0, 10);
  const time = String(b.time || '').slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Pick the interview date.' });
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Pick the interview time.' });
  const mode = BOOK_MODES[String(b.mode || '').trim().toLowerCase()];
  if (!mode) return res.status(400).json({ error: 'Pick Online or In person.' });
  // India time, written out, so the slot never depends on the server's zone.
  const interviewAt = new Date(`${date}T${time}:00+05:30`);
  if (Number.isNaN(interviewAt.getTime())) return res.status(400).json({ error: 'That date or time is not valid.' });
  // B9.10: a year like 2203 is a slip, not a plan.
  const ivYearNo = dateYearProblem(interviewAt, 'interview date');
  if (ivYearNo) return res.status(400).json({ error: ivYearNo });
  if (interviewAt.getTime() < Date.now() - 5 * 60000) return res.status(400).json({ error: 'That time has already passed — pick a later time.' });
  const meetingLink = String(b.meetingLink || '').trim().slice(0, 500);
  const location = String(b.location || '').trim().slice(0, 300);
  // B4: a PANEL — several interviewers (staff logins and / or outside people).
  // The old single "interviewer" text still works on its own.
  // eslint-disable-next-line global-require
  const PANEL = require('../utils/interviewPanel');
  const parsedPanel = await PANEL.parsePanel(b.panel);
  if (parsedPanel.error) return res.status(400).json({ error: parsedPanel.error });
  const panelEntries = parsedPanel.entries && parsedPanel.entries.length ? parsedPanel.entries : null;
  const interviewer = (String(b.interviewer || '').trim() || (panelEntries ? PANEL.namesOf(panelEntries) : '')).slice(0, 120);
  if (mode === 'Online' && meetingLink && !/^https?:\/\/\S+$/i.test(meetingLink)) {
    return res.status(400).json({ error: 'The meeting link should start with https:// (e.g. https://meet.google.com/abc-defg-hij).' });
  }
  if (!interviewer) return res.status(400).json({ error: 'Add who will take the interview (one or more people).' });
  // ROUND (layout v3, the user brought it back): the popup sends the round;
  // left out, it is the next round after feedback, else the same round.
  let round = suggestedRoundOf(app);
  if (b.round !== undefined && b.round !== null && b.round !== '') {
    const n = Number(b.round);
    if (!Number.isInteger(n) || n < 1 || n > 20) return res.status(400).json({ error: 'Round should be a number from 1 to 20.' });
    round = n;
  }

  const LIVE_SLOT = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'];
  let movedStage = false;
  if (!['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'].includes(app.stage)) {
    // eslint-disable-next-line global-require
    const { applyStageMove } = require('./applications');
    // skipNotice: announceInterview below tells the recruiter / TL / BDE with
    // the full slot, so the plain "moved to Interview" notice is not sent too.
    const out = await applyStageMove(req.user, app.id, {
      stage: 'INTERVIEW_SCHEDULED', interviewAt: interviewAt.toISOString(), interviewer, interviewMode: mode, interviewMeetingLink: meetingLink || undefined,
    }, { skipNotice: true });
    if (out.status !== 200) return res.status(out.status).json(out.body);
    movedStage = true;
  } else if (LIVE_SLOT.includes(app.interviewStatus)) {
    return res.status(409).json({ error: `${app.candidate.name} already has an interview booked. Use Reschedule on that row to change the time.` });
  }
  const nextRound = !movedStage && app.interviewStatus === 'FEEDBACK_SUBMITTED';
  await prisma.application.update({
    where: { id: app.id },
    data: {
      interviewAt,
      interviewStatus: 'SCHEDULED',
      interviewMode: mode,
      interviewMeetingLink: mode === 'Online' ? (meetingLink || null) : null,
      interviewLocation: mode === 'In Person' ? (location || null) : null,
      interviewer,
      interviewCode: app.interviewCode || `INT-${app.id.slice(-6).toUpperCase()}`,
      interviewCreatedBy: movedStage ? undefined : req.user.name,
      interviewCancelReason: null,
      interviewRound: round,
    },
  });
  await prisma.interviewEvent.create({
    data: { applicationId: app.id, status: 'SCHEDULED', toSlot: interviewAt.toISOString(), by: req.user.name, reason: nextRound || round > 1 ? `Round ${round} booked` : 'Interview booked' },
  });
  if (panelEntries) await PANEL.setPanel(app.id, round, panelEntries);
  if (!movedStage) {
    await logAudit({
      userId: req.user.id, action: 'Interview booked', entity: 'Application', entityId: app.id,
      fromValue: app.interviewStatus || '—', toValue: interviewAt.toISOString(),
    });
  }
  // eslint-disable-next-line global-require
  const IN = require('../utils/interviewNotices');
  // On the first booking the pipeline move already emailed the candidate
  // ("Interview scheduled"); they still get the in-app notice with the link.
  // EMAIL stays behind the Admin switch (announceInterview + candidateComms);
  // while it is off nothing is emailed. WhatsApp is never sent from here: the
  // reply carries ready wa.me links the user opens on their own device.
  const told = await IN.announceInterview(app.id, 'scheduled', { actor: req.user, candidateEmail: !movedStage });
  const whatsapp = await IN.whatsappLinks(app.id, req.user).catch(() => []);
  const parts = [`Booked: Round ${round}, ${IN.when(interviewAt)}.`];
  if (told.people.length) parts.push(`App notice sent to ${told.people.join(', ')}.`);
  parts.push(told.emailsOff ? 'Emails are off (Admin switch), so no email went out.' : 'Emails sent.');
  if (mode === 'Online' && !meetingLink) parts.push('No meeting link yet: press "Create meeting link", or add it later (Reschedule → same time).');
  res.json({
    ok: true,
    applicationId: app.id,
    interviewAt,
    round,
    told,
    emailsOff: !!told.emailsOff,
    whatsapp,
    message: parts.join(' '),
  });
});

// "Send on WhatsApp" was pressed (layout v3). The message was opened in the
// user's OWN WhatsApp through a wa.me link — the server sends nothing and
// cannot see whether it was sent. This logs it as a follow-up: the open
// follow-up on this interview gets the contact (WhatsApp, now); without one,
// an "Interview confirmation" follow-up is written. The candidate's message
// also lands on Candidate 360 → Communications as "opened on device".
//   body: { to: 'candidate' | 'bde' }
router.post('/interviews/:id/whatsapp-log', requirePerm('ats', 'interviews', 'Schedule Interview', 'create'), async (req, res) => {
  if (!req.user.caps || !req.user.caps.atsAct) return res.status(403).json({ error: "Messaging about interviews isn't part of your role." });
  const app = await loadScoped(req, res);
  if (!app) return;
  const to = String((req.body && req.body.to) || '').trim();
  if (!['candidate', 'bde'].includes(to)) return res.status(400).json({ error: 'Say who the message is for: candidate or bde.' });
  if (!app.interviewStatus) return res.status(400).json({ error: 'Book the interview first.' });
  // eslint-disable-next-line global-require
  const IN = require('../utils/interviewNotices');
  const link = (await IN.whatsappLinks(app.id, req.user)).find((l) => l.to === to);
  if (!link) return res.status(400).json({ error: 'This job has no client manager (BDE).' });
  const who = to === 'candidate' ? `the candidate (${link.name})` : `the client manager (BDE) ${link.name}`;
  const note = `Interview message (round ${app.interviewRound || 1}) opened in WhatsApp for ${who} — sent from the user's own WhatsApp.`;
  if (to === 'candidate') {
    // eslint-disable-next-line global-require
    const { senderIdentity } = require('../utils/candidateComms');
    await prisma.candidateMessage.create({
      data: {
        candidateId: app.candidateId,
        applicationId: app.id,
        channel: 'WhatsApp',
        template: 'INTERVIEW_WHATSAPP',
        templateLabel: 'Interview booked (WhatsApp)',
        trigger: 'Manual',
        recipient: link.phone || '',
        body: link.text,
        // Never QUEUED: the mail worker only sends QUEUED / RETRY WhatsApp rows.
        status: 'OPENED_ON_DEVICE',
        statusDetail: "Opened in the sender's own WhatsApp (wa.me link) — the app cannot see whether it was sent",
        ...(await senderIdentity(req.user)),
      },
    });
  }
  // eslint-disable-next-line global-require
  const { chainSnapshot, resolveNames } = require('../utils/followups');
  const open = await prisma.applicationFollowUp.findFirst({
    where: { applicationId: app.id, completedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  let followUp;
  if (open) {
    followUp = await prisma.applicationFollowUp.update({
      where: { id: open.id },
      data: { lastContactedAt: new Date(), contactMode: 'WhatsApp', notes: [open.notes, note].filter(Boolean).join('\n').slice(0, 4000) },
    });
  } else {
    const names = await resolveNames([app.requirement]);
    const snap = chainSnapshot(app, app.requirement, names);
    if (!snap.ownerUserId) Object.assign(snap, { ownerUserId: req.user.id, ownerName: req.user.name, ownerRole: req.user.atsRole || req.user.role });
    const slotDay = app.interviewAt ? new Date(app.interviewAt.getTime() + 330 * 60000).toISOString().slice(0, 10) : null;
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    followUp = await prisma.applicationFollowUp.create({
      data: {
        applicationId: app.id,
        candidateId: app.candidateId,
        requirementId: app.requirementId,
        ...snap,
        lastContactedAt: new Date(),
        contactMode: 'WhatsApp',
        purpose: 'Interview confirmation',
        nextAction: 'Confirm the candidate is attending',
        dueDate: slotDay && slotDay > today ? slotDay : today,
        notes: note,
        createdById: req.user.id,
        createdByName: req.user.name,
      },
    });
  }
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Interview WhatsApp opened for ${to === 'candidate' ? 'candidate' : 'BDE'}`,
    entity: 'Application', entityId: app.id, toValue: 'Opened on device',
  });
  res.status(201).json({ ok: true, followUpId: followUp.id, message: `Logged as a follow-up: WhatsApp to ${who}.` });
});

// ---------------------------------------------------------------------------
// Interview reminders — the Admin switch, and "Run now" (change list §11).
// OFF until an Admin turns it on. The test sandbox never runs the timer.
// ---------------------------------------------------------------------------
const isAdminLogin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
router.get('/interview-reminders', async (req, res) => {
  // eslint-disable-next-line global-require
  const IN = require('../utils/interviewNotices');
  const s = await IN.loadSettings();
  // eslint-disable-next-line global-require
  const sandboxOn = require('../utils/sandbox').isSandbox();
  const staff = await IN.loadStaffSettings();
  res.json({ ...s, staff, canEdit: isAdminLogin(req.user), timerRuns: !sandboxOn && (s.enabled || staff.enabled), sandbox: sandboxOn });
});
// B4: staff (interviewers, recruiter, TL) in-app reminders — ON by default,
// separate from the "Candidate emails" switch.
router.put('/interview-staff-reminders', async (req, res) => {
  if (!isAdminLogin(req.user)) return res.status(403).json({ error: 'Only an Admin can change staff reminders.' });
  const b = req.body || {};
  if (['enabled', 'dayBefore', 'hourBefore'].some((k) => b[k] !== undefined && typeof b[k] !== 'boolean')) return res.status(400).json({ error: 'Say on or off.' });
  // eslint-disable-next-line global-require
  const IN = require('../utils/interviewNotices');
  const before = await IN.loadStaffSettings();
  const staff = await IN.saveStaffSettings(b, req.user);
  await logAudit({ userId: req.user.id, action: 'Staff interview reminders changed', entity: 'AppSetting', entityId: IN.STAFF_SETTINGS_KEY, fromValue: JSON.stringify(before), toValue: JSON.stringify(staff) });
  res.json({ staff, message: staff.enabled ? 'Saved. Staff get a bell reminder before each interview.' : 'Saved. Staff reminders are off.' });
});
router.put('/interview-reminders', async (req, res) => {
  if (!isAdminLogin(req.user)) return res.status(403).json({ error: 'Only an Admin can switch candidate emails on or off.' });
  if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'Say on or off.' });
  // eslint-disable-next-line global-require
  const IN = require('../utils/interviewNotices');
  const before = await IN.loadSettings();
  const s = await IN.saveSettings({ enabled: req.body.enabled }, req.user);
  await logAudit({ userId: req.user.id, action: `Candidate emails (and interview reminders) switched ${s.enabled ? 'on' : 'off'}`, entity: 'AppSetting', entityId: IN.SETTINGS_KEY, fromValue: before.enabled ? 'On' : 'Off', toValue: s.enabled ? 'On' : 'Off' });
  res.json({ ...s, canEdit: true, message: s.enabled ? 'Candidate emails are on. Step messages, interview messages, offer letters and reminders now go out (reminders every 15 minutes).' : 'Candidate emails are off. Messages are still recorded on Communications, but nothing is sent.' });
});
router.post('/interview-reminders/run', async (req, res) => {
  if (!isAdminLogin(req.user)) return res.status(403).json({ error: 'Only an Admin can run the reminders by hand.' });
  // eslint-disable-next-line global-require
  const IN = require('../utils/interviewNotices');
  // The TEST SANDBOX may simulate the clock (body.now); the real server never.
  // eslint-disable-next-line global-require
  const simNow = require('../utils/sandbox').isSandbox() && req.body.now ? new Date(req.body.now) : null;
  if (simNow && Number.isNaN(simNow.getTime())) return res.status(400).json({ error: 'now is not a date' });
  const out = await IN.runInterviewReminders({
    force: req.body.asTimer !== true, dryRun: req.body.dryRun === true, ...(simNow ? { now: simNow, record: false } : {}),
    // eslint-disable-next-line global-require
    ...(require('../utils/sandbox').isSandbox() && Array.isArray(req.body.onlyIds) ? { onlyIds: req.body.onlyIds.map(String) } : {}),
  });
  await logAudit({ userId: req.user.id, action: `Interview reminders run by hand${out.dryRun ? ' (preview)' : ''}`, entity: 'AppSetting', entityId: IN.SETTINGS_KEY, toValue: JSON.stringify({ d: out.dayBefore, h: out.hourBefore, f: out.feedbackMissing, g: out.guaranteeEnding }) });
  res.json(out);
});

module.exports = router;
