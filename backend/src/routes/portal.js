// ---------------------------------------------------------------------------
// CLIENT PORTAL and CANDIDATE PORTAL — the two screens people OUTSIDE the
// company sign in to (user notes #4, points 3–4).
//
//   GET  /api/portal/client                    the client's whole portal
//   GET  /api/portal/client/resume/:appId      a shared candidate's resume
//   GET  /api/portal/candidate                 the candidate's whole portal
//   PUT  /api/portal/candidate                 edit their own basics
//   POST /api/portal/candidate/resume          upload their resume (PDF)
//   GET  /api/portal/candidate/resume          download their own resume
//   POST /api/portal/candidate/apply/:reqId    apply to an open job
//   GET  /api/portal/access/:kind/:id          does this client/candidate have a login?
//   POST /api/portal/invite/:kind/:id          "Invite to portal" (set-password link)
//   POST /api/portal/public/claim              a candidate asks for their sign-in link
//
// WHAT AN OUTSIDER NEVER GETS, BY CONSTRUCTION: every field below is picked
// by name — nothing is spread from a row. So there is no recruiter / TL / BDE
// name, no internal note, no internal stage code, no AI score, no match
// score, no fee or salary band, no other client and no other candidate
// anywhere in these payloads. The client's decisions themselves go through
// the existing POST /api/job-portal/client/applications/:id/decision.
// ---------------------------------------------------------------------------

const express = require('express');
const fs = require('fs');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { CLIENT_SHARED_STAGES, clientWhere, candidateWhere, invoiceWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const {
  REQUIREMENT_LIVE_STATUSES, requirementIsLive, normalizeAgreementStatus, PORTAL_APPLICATION_SOURCE,
} = require('../utils/atsVocab');
const attachments = require('../utils/attachments');
const { portalLoginFor, loginSummary, inviteToPortal, claimCandidateLogin } = require('../utils/portalAccess');

const router = express.Router();
const wrap = (fn) => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

const isClientLogin = (u) => !!u && (u.role === 'CLIENT' || u.atsRole === 'CLIENT') && !!u.clientId;
const isCandidateLogin = (u) => !!u && (u.role === 'CANDIDATE' || u.atsRole === 'CANDIDATE') && !!u.candidateId;

// A stored resume file is recorded on its CandidateDocument as "file:<name>".
// (CandidateDocument has no file column; `note` carries the reference, and
// attachments.resolveStored() re-validates it before any read.)
const FILE_PREFIX = 'file:';
const storedOf = (doc) => (doc && doc.note && doc.note.startsWith(FILE_PREFIX) ? doc.note.slice(FILE_PREFIX.length) : null);

// ---- Plain words -----------------------------------------------------------
// The candidate is never shown an internal stage code or who is holding
// their profile — just where it stands, in words anyone understands.
function candidateStatus(stage, app) {
  switch (stage) {
    case 'AI_INTERVIEW_REQUIRED':
    case 'AI_INTERVIEW_SCHEDULED':
      return { label: 'AI interview pending', tone: 'amber' };
    case 'SHARED_WITH_CLIENT': case 'CLIENT_REVIEW': case 'CLIENT_SHORTLISTED':
      return { label: 'Shared with employer', tone: 'blue' };
    case 'INTERVIEW_SCHEDULED':
      return { label: 'Interview scheduled', tone: 'blue' };
    case 'INTERVIEW_COMPLETED':
      return { label: 'Interview done — waiting for result', tone: 'amber' };
    case 'SELECTED': return { label: 'Selected', tone: 'green' };
    case 'OFFER': return { label: 'Offer made', tone: 'green' };
    case 'OFFER_ACCEPTED':
      return { label: app && app.joiningDate ? 'Offer accepted — joining scheduled' : 'Offer accepted', tone: 'green' };
    case 'JOINED': case 'HIRED': return { label: 'Joined', tone: 'green' };
    case 'REJECTED': return { label: 'Not selected', tone: 'red' };
    case 'HOLD': return { label: 'On hold', tone: 'amber' };
    default: return { label: 'Under review', tone: 'blue' };
  }
}

// The client's words for where a SHARED candidate stands.
function clientStatus(stage, lastClientDecision) {
  if (['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(stage)) {
    if (lastClientDecision === 'HOLD') return { label: 'On hold (your decision)', tone: 'amber', decide: true };
    return { label: 'Waiting for your review', tone: 'amber', decide: true };
  }
  switch (stage) {
    case 'CLIENT_SHORTLISTED': return { label: 'Shortlisted by you — interview being arranged', tone: 'blue', decide: true };
    case 'INTERVIEW_SCHEDULED': return { label: 'Interview scheduled', tone: 'blue', decide: false };
    case 'INTERVIEW_COMPLETED': return { label: 'Interview done — your feedback / decision', tone: 'amber', decide: false };
    case 'SELECTED': return { label: 'Selected', tone: 'green', decide: false };
    case 'OFFER': return { label: 'Offer made', tone: 'green', decide: false };
    case 'OFFER_ACCEPTED': return { label: 'Offer accepted', tone: 'green', decide: false };
    case 'JOINED': case 'HIRED': return { label: 'Joined', tone: 'green', decide: false };
    case 'REJECTED': return { label: lastClientDecision === 'REJECT' ? 'Rejected by you' : 'Not continuing', tone: 'red', decide: false };
    case 'HOLD': return { label: 'On hold', tone: 'amber', decide: false };
    default: return { label: 'With TeamLink', tone: 'grey', decide: false };
  }
}

const REQ_STATUS_WORDS = (status) => {
  if (requirementIsLive(status)) return 'Open';
  if (status === 'ON_HOLD') return 'On hold';
  if (status === 'CLOSED' || status === 'Closed') return 'Closed';
  return 'Being set up';
};

const AGREEMENT_WORDS = {
  DRAFT: 'Being prepared', SENT: 'Sent to you — waiting for your signature', VIEWED: 'Opened — waiting for your signature',
  CLIENT_CONFIRMATION_PENDING: 'Waiting for your confirmation', CONFIRMED: 'Confirmed', SIGNED: 'Signed',
  ACTIVE: 'Active', CANCELLED: 'Cancelled', EXPIRED: 'Expired', REJECTED: 'Returned by you',
};

const JOINED = ['JOINED', 'HIRED'];
const SELECTED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const isAiInterview = (a) => /ai/i.test(String(a.interviewType || '')) && /interview/i.test(String(a.interviewType || ''));

function interviewOf(a, { forCandidate } = {}) {
  if (!a.interviewAt || isAiInterview(a)) return null;
  const st = String(a.interviewStatus || 'SCHEDULED').toUpperCase();
  const words = {
    SCHEDULED: 'Scheduled', CONFIRMED: 'Confirmed', RESCHEDULED: 'Rescheduled', STARTED: 'In progress',
    COMPLETED: 'Completed', CANCELLED: 'Cancelled', NO_SHOW: forCandidate ? 'Missed' : 'Candidate did not attend',
  };
  return {
    at: a.interviewAt,
    round: a.interviewRound || 1,
    kind: forCandidate ? 'Interview' : (a.interviewType || 'Interview'),
    mode: a.interviewMode || null,
    location: a.interviewLocation || null,
    link: a.interviewMeetingLink || null,
    status: words[st] || 'Scheduled',
    upcoming: new Date(a.interviewAt) >= new Date(new Date().toDateString()) && !['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(st),
  };
}

// ===========================================================================
// CLIENT PORTAL
// ===========================================================================
router.get('/client', requireAuth, wrap(async (req, res) => {
  const u = req.user;
  if (!isClientLogin(u) || !(await can(u, 'ats', 'requirements', 'Client Job Portal', 'view'))) {
    return res.status(403).json({ error: 'The client portal is for client logins.' });
  }
  const clientId = u.clientId;
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true, name: true, legalName: true, clientCode: true, industry: true, location: true, website: true, status: true,
      contactName: true, contactDesignation: true, contactEmail: true, contactPhone: true,
      houseNumber: true, street: true, area: true, landmark: true, state: true, pincode: true, country: true,
      gst: true, pan: true,
      agreementId: true, agreementStatus: true, agreementStart: true, agreementEnd: true, agreementSignedAt: true, agreementActivatedAt: true,
    },
  });
  if (!client) return res.status(404).json({ error: 'Your company record was not found — contact TeamLink.' });

  const reqWhere = { clientId, internal: false };
  const requirements = await prisma.requirement.findMany({
    where: reqWhere,
    select: {
      id: true, reqCode: true, title: true, department: true, location: true, openings: true, status: true,
      experience: true, employmentType: true, workMode: true, createdAt: true, portalPublished: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  const reqIds = requirements.map((r) => r.id);
  const apps = reqIds.length ? await prisma.application.findMany({
    where: { requirementId: { in: reqIds } },
    select: {
      id: true, stage: true, requirementId: true, candidateId: true, createdAt: true, updatedAt: true,
      interviewAt: true, interviewStatus: true, interviewRound: true, interviewType: true, interviewMode: true,
      interviewLocation: true, interviewMeetingLink: true, joiningDate: true, joiningStatus: true, joinedAt: true, offerStatus: true,
      candidate: {
        select: {
          id: true, name: true, experienceYears: true, location: true, skills: true, currentDesignation: true,
          currentCompany: true, education: true, noticePeriod: true, resumeName: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  }) : [];

  // SHARED = at, or ever reached, a stage the client is shown (the same rule
  // routes/jobPortal.js and routes/candidates.js apply).
  const events = apps.length ? await prisma.applicationStageEvent.findMany({
    where: { applicationId: { in: apps.map((a) => a.id) }, OR: [{ toStage: { in: CLIENT_SHARED_STAGES } }, { actorSide: 'Client' }] },
    select: { applicationId: true, toStage: true, action: true, actorSide: true, createdAt: true, comment: true, reasonCategory: true },
    orderBy: { createdAt: 'asc' },
  }) : [];
  const sharedAt = new Map();
  const clientEvents = new Map();
  events.forEach((e) => {
    if (CLIENT_SHARED_STAGES.includes(e.toStage) && !sharedAt.has(e.applicationId)) sharedAt.set(e.applicationId, e.createdAt);
    if (e.actorSide === 'Client') {
      if (!clientEvents.has(e.applicationId)) clientEvents.set(e.applicationId, []);
      clientEvents.get(e.applicationId).push(e);
    }
  });
  const shared = apps.filter((a) => CLIENT_SHARED_STAGES.includes(a.stage) || sharedAt.has(a.id));

  const decisionCode = (action) => {
    const s = String(action || '');
    if (/shortlist/i.test(s)) return 'SHORTLIST';
    if (/reject/i.test(s)) return 'REJECT';
    if (/hold/i.test(s)) return 'HOLD';
    if (/interview/i.test(s)) return 'REQUEST_INTERVIEW';
    return null;
  };

  // Only a resume the candidate or the recruiter did NOT mark internal.
  const resumeDocs = shared.length ? await prisma.candidateDocument.findMany({
    where: { candidateId: { in: [...new Set(shared.map((a) => a.candidateId))] }, docType: 'Resume', internalOnly: false },
    select: { candidateId: true, name: true, note: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  }) : [];
  const resumeOf = new Map();
  resumeDocs.forEach((d) => { if (!resumeOf.has(d.candidateId)) resumeOf.set(d.candidateId, d); });

  // Their OWN feedback records (kind Client, this client) — never the panel's.
  const feedback = shared.length ? await prisma.interviewFeedback.findMany({
    where: { applicationId: { in: shared.map((a) => a.id) }, kind: 'Client', clientId },
    select: { applicationId: true, overall: true, recommendation: true, updatedAt: true },
  }) : [];
  const feedbackOf = new Map(feedback.map((f) => [f.applicationId, f]));

  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const candidates = shared.map((a) => {
    const mine = clientEvents.get(a.id) || [];
    const lastDecision = mine.length ? decisionCode(mine[mine.length - 1].action) : null;
    const st = clientStatus(a.stage, lastDecision);
    const doc = resumeOf.get(a.candidateId);
    const fb = feedbackOf.get(a.id);
    return {
      applicationId: a.id,
      candidateId: a.candidateId,
      name: a.candidate.name,
      experienceYears: a.candidate.experienceYears,
      location: a.candidate.location,
      skills: a.candidate.skills,
      currentRole: [a.candidate.currentDesignation, a.candidate.currentCompany].filter(Boolean).join(' · ') || null,
      education: a.candidate.education,
      noticePeriod: a.candidate.noticePeriod,
      requirementId: a.requirementId,
      requirement: reqById.get(a.requirementId) ? reqById.get(a.requirementId).title : null,
      status: st.label,
      tone: st.tone,
      // Shortlist / Hold / Reject / Request Interview are offered while the
      // profile is in the client's own review; the API re-checks.
      canDecide: st.decide,
      canShortlist: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage),
      sharedAt: sharedAt.get(a.id) || a.createdAt,
      interview: interviewOf(a),
      resume: doc ? { name: doc.name, downloadable: !!storedOf(doc) } : (a.candidate.resumeName ? { name: a.candidate.resumeName, downloadable: false } : null),
      yourDecisions: mine.map((e) => ({ decision: decisionCode(e.action), label: e.action, note: e.comment || e.reasonCategory || null, at: e.createdAt })),
      yourFeedback: fb ? { recommendation: fb.recommendation, comment: fb.overall, at: fb.updatedAt } : null,
    };
  });

  const count = (reqId, pred) => shared.filter((a) => a.requirementId === reqId && pred(a)).length;
  const reqRows = requirements.map((r) => {
    const joined = count(r.id, (a) => JOINED.includes(a.stage));
    return {
      id: r.id,
      reqCode: r.reqCode,
      title: r.title,
      department: r.department,
      location: r.location,
      experience: r.experience,
      employmentType: r.employmentType,
      workMode: r.workMode,
      openings: r.openings || 1,
      filled: joined,
      openLeft: Math.max(0, (r.openings || 1) - joined),
      status: REQ_STATUS_WORDS(r.status),
      live: requirementIsLive(r.status),
      raisedAt: r.createdAt,
      shared: count(r.id, () => true),
      waitingForYou: count(r.id, (a) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage)),
      interviews: count(r.id, (a) => ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'].includes(a.stage)),
      selected: count(r.id, (a) => SELECTED.includes(a.stage)),
      joined,
    };
  });

  const interviews = candidates.filter((c) => c.interview).map((c) => ({
    applicationId: c.applicationId, candidate: c.name, requirement: c.requirement, ...c.interview,
  })).sort((x, y) => new Date(x.at) - new Date(y.at));

  const hires = shared.filter((a) => SELECTED.includes(a.stage) || JOINED.includes(a.stage)).map((a) => ({
    applicationId: a.id,
    candidate: a.candidate.name,
    requirement: reqById.get(a.requirementId) ? reqById.get(a.requirementId).title : null,
    status: JOINED.includes(a.stage) ? 'Joined' : (a.stage === 'OFFER_ACCEPTED' ? 'Offer accepted' : a.stage === 'OFFER' ? 'Offer made' : 'Selected'),
    joiningDate: a.joiningDate || null,
    joinedAt: a.joinedAt || null,
  }));

  // Invoices ONLY where the app already exposes them to this login
  // (accounts / Invoices / view — a client holds it only if Billing access was
  // granted on Administration → Users). Otherwise the section is absent.
  let invoices = null;
  if (await can(u, 'accounts', 'accounts', 'Invoices', 'view')) {
    const rows = await prisma.invoice.findMany({
      where: { AND: [invoiceWhere(u), { clientId }] },
      select: { id: true, invoiceNumber: true, invoiceDate: true, dueDate: true, amount: true, gst: true, status: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }).catch(() => null);
    invoices = rows;
  }

  const agStatus = normalizeAgreementStatus(client.agreementStatus);
  const address = [client.houseNumber, client.street, client.area, client.landmark, client.location, client.state, client.pincode]
    .filter(Boolean).join(', ');
  res.json({
    company: {
      name: client.name,
      legalName: client.legalName,
      clientCode: client.clientCode,
      industry: client.industry,
      location: client.location,
      address: address || null,
      website: client.website,
      gst: client.gst,
      pan: client.pan,
      status: client.status || 'Active',
      contact: { name: client.contactName, designation: client.contactDesignation, email: client.contactEmail, phone: client.contactPhone },
    },
    requirements: reqRows,
    candidates,
    interviews,
    hires,
    // The agreement VIEW / e-sign screen belongs to the Client 360 → Agreement
    // tab (the agreement workflow's own screen); this is only its summary.
    agreement: client.agreementId || agStatus !== 'DRAFT' ? {
      id: client.agreementId,
      status: AGREEMENT_WORDS[agStatus] || agStatus,
      needsYou: ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(agStatus),
      start: client.agreementStart,
      end: client.agreementEnd,
      signedAt: client.agreementSignedAt,
      activatedAt: client.agreementActivatedAt,
      viewPath: `/clients/${client.id}?tab=agreement`,
    } : null,
    invoices,
    totals: {
      openRequirements: reqRows.filter((r) => r.live).length,
      openings: reqRows.filter((r) => r.live).reduce((n, r) => n + r.openLeft, 0),
      waitingForYou: candidates.filter((c) => /Waiting for your review|On hold \(your/.test(c.status)).length,
      upcomingInterviews: interviews.filter((i) => i.upcoming).length,
      selected: hires.filter((h) => h.status !== 'Joined').length,
      joined: hires.filter((h) => h.status === 'Joined').length,
    },
    permissions: { decide: await can(u, 'ats', 'requirements', 'Client Job Portal', 'edit') },
  });
}));

router.get('/client/resume/:applicationId', requireAuth, wrap(async (req, res) => {
  const u = req.user;
  if (!isClientLogin(u)) return res.status(403).json({ error: 'The client portal is for client logins.' });
  const app = await prisma.application.findFirst({
    where: { id: req.params.applicationId, requirement: { clientId: u.clientId, internal: false } },
    select: { id: true, stage: true, candidateId: true },
  });
  if (!app) return res.status(404).json({ error: 'Candidate not found' });
  let shared = CLIENT_SHARED_STAGES.includes(app.stage);
  if (!shared) {
    shared = !!(await prisma.applicationStageEvent.findFirst({ where: { applicationId: app.id, toStage: { in: CLIENT_SHARED_STAGES } }, select: { id: true } }));
  }
  if (!shared) return res.status(404).json({ error: 'Candidate not found' });
  const doc = await prisma.candidateDocument.findFirst({
    where: { candidateId: app.candidateId, docType: 'Resume', internalOnly: false, note: { startsWith: FILE_PREFIX } },
    orderBy: { createdAt: 'desc' },
  });
  const full = doc && attachments.resolveStored(storedOf(doc));
  if (!full) return res.status(404).json({ error: 'No resume file has been shared for this candidate yet.' });
  res.setHeader('Content-Disposition', `inline; filename="${String(doc.name).replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('Content-Type', full.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
  return undefined;
}));

// ===========================================================================
// CANDIDATE PORTAL
// ===========================================================================
const PROFILE_FIELDS = {
  phone: 'Phone', location: 'Current location', preferredLocation: 'Preferred location', currentCompany: 'Current company',
  currentDesignation: 'Current role', experienceYears: 'Experience (years)', noticePeriod: 'Notice period',
  expectedSalary: 'Expected salary', education: 'Education', skills: 'Key skills',
};

function candidateOnly(req, res) {
  if (!isCandidateLogin(req.user)) {
    res.status(403).json({ error: 'The candidate portal is for candidate logins.' });
    return false;
  }
  return true;
}

router.get('/candidate', requireAuth, wrap(async (req, res) => {
  if (!candidateOnly(req, res)) return undefined;
  const cid = req.user.candidateId;
  const c = await prisma.candidate.findUnique({
    where: { id: cid },
    select: {
      id: true, name: true, email: true, phone: true, location: true, preferredLocation: true, currentCompany: true,
      currentDesignation: true, experienceYears: true, noticePeriod: true, expectedSalary: true, education: true, skills: true,
      resumeName: true,
    },
  });
  if (!c) return res.status(404).json({ error: 'Your profile was not found — contact TeamLink.' });
  const apps = await prisma.application.findMany({
    where: { candidateId: cid },
    select: {
      id: true, stage: true, createdAt: true, updatedAt: true,
      interviewAt: true, interviewStatus: true, interviewRound: true, interviewType: true, interviewMode: true,
      interviewLocation: true, interviewMeetingLink: true, aiInterviewStatus: true, aiInterviewDeadline: true,
      offerStatus: true, offerDate: true, offeredCtc: true, joiningDate: true, joiningStatus: true, documentsStatus: true, joinedAt: true,
      requirement: { select: { id: true, reqCode: true, title: true, location: true, internal: true, client: { select: { name: true } } } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  // The employer is named once the candidate is interviewing with them —
  // before that TeamLink keeps the client confidential, as its job feeds do.
  const REVEAL = ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
  const applications = apps.map((a) => {
    const st = candidateStatus(a.stage, a);
    const aiPending = ['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED'].includes(a.stage)
      && !/completed|expired/i.test(String(a.aiInterviewStatus || ''));
    const offer = ['OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'SELECTED'].includes(a.stage) ? {
      status: a.offerStatus || (a.stage === 'SELECTED' ? 'Offer being prepared' : null),
      date: a.offerDate || null,
      ctc: a.offeredCtc || null,
      joiningDate: a.joiningDate || null,
      joiningStatus: a.joiningStatus || null,
      documents: a.documentsStatus || null,
      joinedAt: a.joinedAt || null,
    } : null;
    return {
      id: a.id,
      jobTitle: a.requirement ? a.requirement.title : '—',
      reference: a.requirement ? a.requirement.reqCode : null,
      location: a.requirement ? a.requirement.location : null,
      company: a.requirement && a.requirement.internal
        ? 'TeamLink Consultants'
        : (REVEAL.includes(a.stage) && a.requirement && a.requirement.client ? a.requirement.client.name : 'Shared when your interview is fixed'),
      status: st.label,
      tone: st.tone,
      appliedAt: a.createdAt,
      updatedAt: a.updatedAt,
      interview: interviewOf(a, { forCandidate: true }),
      aiInterview: aiPending ? { pending: true, deadline: a.aiInterviewDeadline || null, link: null } : null,
      offer,
    };
  });
  const doc = await prisma.candidateDocument.findFirst({
    where: { candidateId: cid, docType: 'Resume' }, orderBy: { createdAt: 'desc' }, select: { name: true, note: true, createdAt: true },
  });
  const appliedReq = new Set(apps.map((a) => a.requirement && a.requirement.id).filter(Boolean));
  const jobs = await prisma.requirement.findMany({
    where: { status: { in: REQUIREMENT_LIVE_STATUSES }, portalPublished: true },
    select: { id: true, reqCode: true, title: true, location: true, experience: true, employmentType: true, workMode: true, department: true, portalPublishedAt: true, createdAt: true },
    orderBy: { portalPublishedAt: 'desc' },
    take: 50,
  });
  res.json({
    profile: { ...c, fields: PROFILE_FIELDS },
    resume: doc ? { name: doc.name, uploadedAt: doc.createdAt, downloadable: !!storedOf(doc) } : (c.resumeName ? { name: c.resumeName, downloadable: false } : null),
    applications,
    interviews: applications.filter((a) => a.interview).map((a) => ({ applicationId: a.id, jobTitle: a.jobTitle, company: a.company, ...a.interview })),
    openJobs: jobs.map((j) => ({
      id: j.id, reference: j.reqCode, title: j.title, location: j.location, experience: j.experience,
      employmentType: j.employmentType, workMode: j.workMode, department: j.department,
      postedAt: j.portalPublishedAt || j.createdAt, applied: appliedReq.has(j.id),
    })),
  });
}));

router.put('/candidate', requireAuth, wrap(async (req, res) => {
  if (!candidateOnly(req, res)) return undefined;
  const b = req.body || {};
  const data = {};
  Object.keys(PROFILE_FIELDS).forEach((k) => {
    if (b[k] === undefined) return;
    if (k === 'experienceYears') {
      const n = b[k] === '' || b[k] === null ? null : Number(b[k]);
      if (n !== null && (!Number.isFinite(n) || n < 0 || n > 60)) return;
      data[k] = n;
    } else {
      data[k] = String(b[k] == null ? '' : b[k]).trim().slice(0, 300) || null;
    }
  });
  if (data.phone && !/^[+\d][\d\s-]{6,18}$/.test(data.phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to save.' });
  await prisma.candidate.update({ where: { id: req.user.candidateId }, data });
  await logAudit({ userId: req.user.id, action: 'Candidate updated own profile (portal)', entity: 'Candidate', entityId: req.user.candidateId, toValue: Object.keys(data).join(', ') });
  return res.json({ ok: true, saved: Object.keys(data) });
}));

router.post('/candidate/resume', requireAuth, wrap(async (req, res) => {
  if (!candidateOnly(req, res)) return undefined;
  let parsed;
  try { parsed = await attachments.parseMultipart(req); } catch (e) { return res.status(400).json({ error: attachments.MESSAGE[e.code] || 'Upload failed.' }); }
  const file = parsed.file;
  if (!file) return res.status(400).json({ error: attachments.MESSAGE.NO_FILE });
  if (file.contentType !== 'application/pdf') return res.status(400).json({ error: 'Upload your resume as a PDF file.' });
  let stored;
  try { stored = attachments.store(file); } catch (e) { return res.status(400).json({ error: attachments.MESSAGE[e.code] || 'Upload failed.' }); }
  const doc = await prisma.candidateDocument.create({
    data: {
      candidateId: req.user.candidateId, docType: 'Resume', name: stored.billName, note: `${FILE_PREFIX}${stored.billFile}`,
      internalOnly: false, uploadedByUserId: req.user.id, uploadedByName: `${req.user.name} (candidate)`,
    },
  });
  await prisma.candidate.update({ where: { id: req.user.candidateId }, data: { resumeName: stored.billName } });
  await logAudit({ userId: req.user.id, action: 'Candidate uploaded resume (portal)', entity: 'Candidate', entityId: req.user.candidateId, toValue: stored.billName });
  return res.status(201).json({ ok: true, name: doc.name, uploadedAt: doc.createdAt, storedName: stored.billFile });
}));

router.get('/candidate/resume', requireAuth, wrap(async (req, res) => {
  if (!candidateOnly(req, res)) return undefined;
  const doc = await prisma.candidateDocument.findFirst({
    where: { candidateId: req.user.candidateId, docType: 'Resume', note: { startsWith: FILE_PREFIX } }, orderBy: { createdAt: 'desc' },
  });
  const full = doc && attachments.resolveStored(storedOf(doc));
  if (!full) return res.status(404).json({ error: 'No resume uploaded yet.' });
  res.setHeader('Content-Disposition', `inline; filename="${String(doc.name).replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('Content-Type', 'application/pdf');
  fs.createReadStream(full).pipe(res);
  return undefined;
}));

router.post('/candidate/apply/:requirementId', requireAuth, wrap(async (req, res) => {
  if (!candidateOnly(req, res)) return undefined;
  const job = await prisma.requirement.findUnique({ where: { id: req.params.requirementId }, select: { id: true, title: true, status: true, portalPublished: true, recruiterId: true, tlId: true } });
  if (!job || !requirementIsLive(job.status) || !job.portalPublished) return res.status(404).json({ error: 'This job is not open any more.' });
  const exists = await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId: req.user.candidateId, requirementId: job.id } } });
  if (exists) return res.status(409).json({ error: 'You have already applied to this job.' });
  const app = await prisma.application.create({
    data: {
      candidateId: req.user.candidateId, requirementId: job.id, stage: 'NEW', source: PORTAL_APPLICATION_SOURCE,
      firstSource: PORTAL_APPLICATION_SOURCE, applicationMethod: 'Auto-Apply',
    },
  });
  await logAudit({ userId: req.user.id, action: 'Candidate applied (portal)', entity: 'Application', entityId: app.id, toValue: job.title });
  await notifyUsers([job.recruiterId, job.tlId], { title: 'New application from the candidate portal', message: `${req.user.name} → ${job.title}` });
  return res.status(201).json({ ok: true, applicationId: app.id, message: 'Application sent. You can follow it under My Applications.' });
}));

// ===========================================================================
// PORTAL LOGINS — who has one, and "Invite to portal"
// ===========================================================================
// Client: SA / Admin / the client's BDE (clients / Client Detail / assign —
// a Manager's view-only rule refuses it in can()). Candidate: whoever edits
// the candidate (candidates / Candidate Master / edit), in their own scope.
async function loadForInvite(req, res) {
  const kind = req.params.kind;
  if (!['client', 'candidate'].includes(kind)) { res.status(404).json({ error: 'Unknown portal' }); return null; }
  const u = req.user;
  const allowed = kind === 'client'
    ? await can(u, 'ats', 'clients', 'Client Detail', 'assign')
    : await can(u, 'ats', 'candidates', 'Candidate Master', 'edit');
  if (!allowed) { res.status(403).json({ error: 'Your role cannot invite people to the portal.' }); return null; }
  const record = kind === 'client'
    ? await prisma.client.findFirst({ where: { AND: [{ id: req.params.id }, clientWhere(u)] }, select: { id: true, name: true, contactName: true, contactEmail: true, recruitmentContactEmail: true, recruitmentContactName: true, agreementStatus: true, clientType: true } })
    : await prisma.candidate.findFirst({ where: { AND: [{ id: req.params.id }, candidateWhere(u)] }, select: { id: true, name: true, email: true } });
  if (!record) { res.status(404).json({ error: `${kind === 'client' ? 'Client' : 'Candidate'} not found, or outside your access scope` }); return null; }
  if (kind === 'client' && record.clientType === 'Internal') { res.status(400).json({ error: 'TeamLink\'s own internal client has no portal.' }); return null; }
  return { kind, record };
}

router.get('/access/:kind/:id', requireAuth, wrap(async (req, res) => {
  const got = await loadForInvite(req, res);
  if (!got) return undefined;
  const login = await portalLoginFor(got.kind, got.record.id);
  const r = got.record;
  const agreement = got.kind === 'client' ? normalizeAgreementStatus(r.agreementStatus) : null;
  return res.json({
    login: loginSummary(login),
    suggestedEmail: got.kind === 'client' ? (r.contactEmail || r.recruitmentContactEmail || '') : (r.email || ''),
    suggestedName: got.kind === 'client' ? (r.contactName || r.recruitmentContactName || r.name) : r.name,
    // The rule: a client is invited once the agreement is out (Sent) or Active.
    recommended: got.kind === 'client' ? ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING', 'CONFIRMED', 'SIGNED', 'ACTIVE'].includes(agreement) && !login : !login,
    agreementStatus: agreement,
  });
}));

router.post('/invite/:kind/:id', requireAuth, wrap(async (req, res) => {
  const got = await loadForInvite(req, res);
  if (!got) return undefined;
  const r = got.record;
  // Re-sending to an existing login goes to THAT login's address.
  const existing = await portalLoginFor(got.kind, r.id);
  const email = (req.body && req.body.email) || (existing && existing.email) || (got.kind === 'client' ? (r.contactEmail || r.recruitmentContactEmail) : r.email);
  const name = (req.body && req.body.name) || (got.kind === 'client' ? (r.contactName || r.recruitmentContactName || r.name) : r.name);
  // Mail goes out only when the inviter asks for it (send: true).
  const out = await inviteToPortal({ kind: got.kind, record: r, email, name, req, actingUser: req.user, send: !!(req.body && req.body.send) });
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  await logAudit({
    userId: req.user.id,
    action: `${out.created ? 'Portal login created' : 'Portal invite re-issued'} (${got.kind})`,
    entity: got.kind === 'client' ? 'Client' : 'Candidate',
    entityId: r.id,
    toValue: `${out.user.email} · ${out.sent ? 'mailed' : 'link handed to inviter'}`,
  });
  return res.status(out.created ? 201 : 200).json({
    created: out.created, email: out.user.email, sent: out.sent, status: out.status, link: out.link, expiresAt: out.expiresAt,
    login: loginSummary(await portalLoginFor(got.kind, r.id)),
  });
}));

// PUBLIC — "Get my sign-in link". Same answer whether or not the email is
// known (no account enumeration), and the link only ever goes BY MAIL.
const claimHits = new Map();
router.post('/public/claim', wrap(async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const key = `${req.ip}|${email}`;
  const now = Date.now();
  const hits = (claimHits.get(key) || []).filter((t) => now - t < 3600000);
  if (hits.length >= 3) return res.status(429).json({ error: 'Too many requests — try again in an hour.' });
  hits.push(now); claimHits.set(key, hits);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter the email address you applied with.' });
  const out = await claimCandidateLogin({ email, req });
  if (out.matched) {
    await logAudit({ userId: out.userId || null, action: `Candidate portal sign-in link requested${out.created ? ' (login created)' : ''}`, entity: 'User', entityId: out.userId || null, toValue: out.sent ? 'Mailed' : 'Not mailed' });
  }
  return res.json({ message: 'If you have applied with this email, a sign-in link has been sent to it. The link works once and expires in 48 hours.' });
}));

module.exports = router;
