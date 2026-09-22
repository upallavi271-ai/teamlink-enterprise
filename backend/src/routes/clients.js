const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct, can } = require('../middleware/auth');
const {
  clientWhere, requirementWhere, applicationWhere, scopeOf, OUT_OF_SCOPE,
} = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { buildAgreementDocument, nextAgreementId, newEsignToken } = require('../utils/agreement');
const {
  normalizeAgreementStatus, agreementIsSigned, agreementIsActive, requirementIsLive,
  applicationIsOverdue, applicationDueDate,
} = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
router.use(requirePerm('ats', 'clients', 'Client List', 'view'));

// ---------------------------------------------------------------------------
// VIEW != EDIT. Per-record permissions are resolved here, server-side, and
// shipped on the payload so the screen renders exactly the buttons the API
// would honour. The six the brief names map onto the engine's action set:
//
//   VIEW    -> clients/Client Detail/view          (+ data scope)
//   EDIT    -> clients/Client Detail/edit
//   APPROVE -> clients/Agreement Lifecycle/approve (the client e-signs)
//   ASSIGN  -> clients/Client Detail/assign        (account manager / BDE)
//   SHARE   -> clients/Agreement Lifecycle/create  (send the agreement out)
//   EXPORT  -> clients/Client List/export
//
// There is no second permission path: every line below is a can() call.
// ---------------------------------------------------------------------------
async function clientPermissions(user) {
  const [view, edit, approve, assign, share, exportable, terms, lifecycle] = await Promise.all([
    can(user, 'ats', 'clients', 'Client Detail', 'view'),
    can(user, 'ats', 'clients', 'Client Detail', 'edit'),
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'approve'),
    can(user, 'ats', 'clients', 'Client Detail', 'assign'),
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'create'),
    can(user, 'ats', 'clients', 'Client List', 'export'),
    can(user, 'ats', 'clients', 'Commercial Terms', 'edit'),
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'edit'),
  ]);
  return { view, edit, approve, assign, share, export: exportable, commercialTerms: terms, lifecycle };
}

// A client login sees its OWN company and its own related data — and never a
// fee, a salary internal, a recruiter note or an AI evaluation.
const isClient = (user) => scopeOf(user).role === 'CLIENT';

// Every /:id endpoint below — read and write — is scope-checked in one place
// against the SAME clientWhere() the list query uses, so a client login can
// never reach another client's record by URL and a recruiter can never reach
// a client they hold no requirement for.
router.param('id', async (req, res, next, id) => {
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const inScope = await prisma.client.findFirst({
    where: { AND: [{ id }, clientWhere(req.user)] },
    select: { id: true },
  });
  if (!inScope) return res.status(403).json(OUT_OF_SCOPE);
  req.client = client;
  return next();
});

// Normalise the stored status on the way out so a row written before this
// round (CONFIRMED / CANCELLED) renders in the current vocabulary.
function shapeClient(client, permissions) {
  if (!client) return client;
  return { ...client, agreementStatus: normalizeAgreementStatus(client.agreementStatus), permissions };
}


// ---------------------------------------------------------------------------
// §12 — WHAT IS OWED ON THIS CLIENT, AND BY WHOM.
//
// The Clients table was administrative — code, industry, GST, agreement,
// expiry — which tells you who they are and nothing about what to do. These
// four fields make the screen operational: status, next action, owner, due.
//
// The answer is read off the client's OWN WORK in priority order, so the most
// blocking thing wins: a missing agreement stops everything, then candidates
// waiting on a decision, then feedback, then joining. A client with nothing
// outstanding says so rather than inventing a task.
//
// Every count here comes from the applications this caller may already see —
// the same applicationWhere() the pipeline uses — so this cannot become a way
// to learn about work outside a scope.
// ---------------------------------------------------------------------------
async function clientWorkload(user, clients) {
  const ids = clients.map((c) => c.id);
  if (!ids.length) return new Map();

  const [apps, openReqs] = await Promise.all([
    prisma.application.findMany({
      where: { ...applicationWhere(user), requirement: { is: { clientId: { in: ids } } } },
      include: { requirement: { include: { bde: true, recruiter: true } } },
    }),
    prisma.requirement.findMany({
      where: { ...requirementWhere(user), clientId: { in: ids } },
      select: { id: true, clientId: true, status: true, recruiterId: true },
    }),
  ]);

  const out = new Map();
  clients.forEach((c) => {
    const mine = apps.filter((a) => a.requirement && a.requirement.clientId === c.id);
    const reqs = openReqs.filter((r) => r.clientId === c.id);
    // Whoever the work actually sits with — the BDE on their requirements,
    // falling back to the recruiter. A person, never a status (§5).
    const owner = (mine.find((a) => a.requirement.bde) || {}).requirement?.bde?.name
      || (mine.find((a) => a.requirement.recruiter) || {}).requirement?.recruiter?.name
      || c.accountManager || null;

    const awaitingDecision = mine.filter((a) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage));
    const awaitingFeedback = mine.filter((a) => a.stage === 'INTERVIEW_COMPLETED');
    const joining = mine.filter((a) => ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(a.stage));
    const unstaffed = reqs.filter((r) => !r.recruiterId);
    const overdue = mine.filter(applicationIsOverdue);

    let nextAction = null;
    let status = 'Active';
    if (normalizeAgreementStatus(c.agreementStatus) !== 'ACTIVE') {
      status = 'Agreement pending';
      nextAction = 'Complete the agreement before sharing candidates';
    } else if (awaitingDecision.length) {
      status = 'Awaiting client decision';
      nextAction = `Client decision pending — ${awaitingDecision.length} candidate(s)`;
    } else if (awaitingFeedback.length) {
      status = 'Awaiting interview feedback';
      nextAction = `Interview feedback pending — ${awaitingFeedback.length}`;
    } else if (joining.length) {
      status = 'Joining in progress';
      nextAction = `Confirm joining — ${joining.length} candidate(s)`;
    } else if (unstaffed.length) {
      status = 'Requirement unstaffed';
      nextAction = `Assign a recruiter — ${unstaffed.length} requirement(s)`;
    } else if (reqs.length) {
      status = 'Sourcing';
      nextAction = 'Source and share candidates';
    } else {
      status = 'No open work';
    }

    // The soonest SLA among the things that are actually waiting.
    const dates = [...awaitingDecision, ...awaitingFeedback, ...joining]
      .map((a) => applicationDueDate(a)).filter(Boolean).sort();

    out.set(c.id, {
      workStatus: status,
      nextAction,
      nextActionOwner: nextAction ? owner : null,
      nextActionDue: dates[0] || null,
      nextActionOverdue: overdue.length > 0,
      openRequirements: reqs.length,
      awaitingDecision: awaitingDecision.length,
    });
  });
  return out;
}

router.get('/', async (req, res) => {
  // Scoped by utils/scope.js: a client sees their own company, a BDE and a
  // recruiter their assigned clients, a TL / Manager the directory.
  const [clients, permissions] = await Promise.all([
    prisma.client.findMany({ where: clientWhere(req.user), orderBy: { name: 'asc' } }),
    clientPermissions(req.user),
  ]);
  // §12 — what is owed on each client, beside who they are.
  const work = await clientWorkload(req.user, clients);
  res.json(clients.map((c) => ({ ...shapeClient(c, permissions), ...(work.get(c.id) || {}) })));
});

// Live "Agreement Template Preview" pane in the Add Client modal (the
// prototype's refreshAgreementPreview, line 7428). Nothing is stored — this
// renders the same template the real document is built from, so the two can
// never drift. It is also the workflow's own Preview step.
router.get('/agreement-preview', (req, res) => {
  const fee = Number(req.query.feePercent);
  res.json({
    document: buildAgreementDocument({
      name: (req.query.name || '').trim() || '(company name)',
      location: req.query.location || null,
      agreementFeePercent: Number.isFinite(fee) && fee > 0 ? fee : 8.33,
      gst: req.query.gst || null,
      tdsPercent: req.query.tdsPercent != null ? Number(req.query.tdsPercent) : undefined,
      paymentTerms: req.query.paymentTerms || undefined,
      guaranteePeriod: req.query.guaranteePeriod || undefined,
    }),
  });
});

router.get('/:id', async (req, res) => {
  res.json(shapeClient(req.client, await clientPermissions(req.user)));
});

// ---------------------------------------------------------------------------
// GET /clients/:id/overview — everything the Client Detail tabs show, in one
// scoped, redacted payload: Requirements, Candidates, Interviews, Selections,
// Joinings, Invoices and Activity.
//
// It is assembled HERE rather than by the browser stitching /applications and
// /invoices together, because a client login must never be handed the rows it
// is then asked not to render. Fee, salary, AI evaluation, recruiter notes and
// pipeline sourcing detail are stripped from the payload itself.
// ---------------------------------------------------------------------------
const SELECTED_STAGES = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const JOINED_STAGES = ['JOINED', 'HIRED'];
const CLIENT_VISIBLE_STAGES = [
  'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED',
];

function shapeApplication(a, forClient) {
  const base = {
    id: a.id,
    stage: a.stage,
    createdAt: a.createdAt,
    requirementId: a.requirementId,
    requirementTitle: a.requirement ? a.requirement.title : null,
    requirementCode: a.requirement ? a.requirement.reqCode : null,
    candidateId: a.candidateId,
    candidateName: a.candidate ? a.candidate.name : null,
    candidateLocation: a.candidate ? a.candidate.location : null,
    candidateExperience: a.candidate ? a.candidate.experienceYears : null,
    candidateSkills: a.candidate ? a.candidate.skills : null,
    candidateDesignation: a.candidate ? a.candidate.currentDesignation : null,
    interviewCode: a.interviewCode,
    interviewAt: a.interviewAt,
    interviewStatus: a.interviewStatus,
    interviewRound: a.interviewRound,
    interviewType: a.interviewType,
    interviewMode: a.interviewMode,
    interviewer: a.interviewer,
    interviewResult: a.interviewResult,
    joiningDate: a.joiningDate,
  };
  if (forClient) return base;
  // Internal-only: the evaluation trail, the sourcing trail and the money.
  return {
    ...base,
    candidateEmail: a.candidate ? a.candidate.email : null,
    candidatePhone: a.candidate ? a.candidate.phone : null,
    candidateCurrentSalary: a.candidate ? a.candidate.currentSalary : null,
    candidateExpectedSalary: a.candidate ? a.candidate.expectedSalary : null,
    matchScore: a.matchScore,
    resumeScore: a.resumeScore,
    aiInterviewStatus: a.aiInterviewStatus,
    aiInterviewScore: a.aiInterviewScore,
    aiInterviewFeedback: a.aiInterviewFeedback,
    interviewFeedback: a.interviewFeedback,
    interviewScore: a.interviewScore,
    source: a.source,
    firstSource: a.firstSource,
    sourceCampaign: a.sourceCampaign,
    offeredCtc: a.offeredCtc,
  };
}

router.get('/:id/overview', async (req, res) => {
  const forClient = isClient(req.user);
  const id = req.client.id;

  // Requirements are scoped by the SAME requirementWhere() the requirements
  // router uses, so a recruiter opening a client sees only their own.
  const requirements = await prisma.requirement.findMany({
    where: { AND: [{ clientId: id }, requirementWhere(req.user)] },
    include: { recruiter: true, bde: true },
    orderBy: { createdAt: 'desc' },
  });
  const reqIds = requirements.map((r) => r.id);

  const [applications, invoices] = await Promise.all([
    reqIds.length
      ? prisma.application.findMany({
        where: {
          requirementId: { in: reqIds },
          ...(forClient ? { stage: { in: CLIENT_VISIBLE_STAGES } } : {}),
        },
        include: { candidate: true, requirement: true },
        orderBy: { updatedAt: 'desc' },
      })
      : [],
    prisma.invoice.findMany({ where: { clientId: id }, orderBy: { invoiceDate: 'desc' } }),
  ]);

  const shaped = applications.map((a) => shapeApplication(a, forClient));

  // Activity: the audit trail for this client and its requirements. A client
  // login sees only the agreement milestones on its own record — never who
  // inside TeamLink touched which requirement.
  const auditWhere = forClient
    ? { entity: 'Client', entityId: id }
    : { OR: [{ entity: 'Client', entityId: id }, { entity: 'Requirement', entityId: { in: reqIds.length ? reqIds : ['__none__'] } }] };
  const activity = await prisma.auditLog.findMany({
    where: auditWhere,
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 60,
  });

  // A client never sees the money side of an invoice beyond what it owes.
  const invoiceRows = invoices.map((i) => (forClient
    ? {
      id: i.id, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, dueDate: i.dueDate,
      amount: i.amount, gst: i.gst, tds: i.tds, status: i.status,
    }
    : i));

  res.json({
    requirements: requirements.map((r) => ({
      ...r,
      recruiterName: r.recruiter ? r.recruiter.name : null,
      bdeName: r.bde ? r.bde.name : null,
      recruiter: undefined,
      bde: undefined,
      live: requirementIsLive(r.status),
    })),
    candidates: shaped,
    interviews: shaped.filter((a) => a.interviewAt || a.interviewStatus || a.interviewCode),
    selections: shaped.filter((a) => SELECTED_STAGES.includes(a.stage)),
    joinings: shaped.filter((a) => JOINED_STAGES.includes(a.stage)),
    invoices: invoiceRows,
    activity: activity.map((a) => ({
      id: a.id,
      action: a.action,
      entity: a.entity,
      fromValue: a.fromValue,
      toValue: a.toValue,
      createdAt: a.createdAt,
      by: forClient ? null : (a.user ? a.user.name : 'System'),
    })),
    redacted: forClient,
  });
});

// Every field the prototype's saveNewClient() (line 7437) records, grouped by
// the tab it sits on in the Add Client modal, plus the clireq profile depth.
const CLIENT_FIELDS = {
  text: [
    // Basic Info
    'name', 'clientCode', 'legalName', 'website', 'industry', 'ownerDepartment', 'yearEstablished', 'landline',
    'status', 'activeDate', 'clientType', 'priority',
    'contactName', 'contactDesignation', 'contactPhone', 'contactEmail', 'contactWhatsApp',
    'secondaryContactName', 'secondaryContactDesignation', 'secondaryContactPhone', 'secondaryContactEmail',
    'commPrimary', 'commSecondary', 'commChannels',
    'houseNumber', 'street', 'landmark', 'area', 'pincode', 'country', 'state', 'location',
    // Billing & recruitment contacts (clireq)
    'billingContactName', 'billingContactDesignation', 'billingContactEmail', 'billingContactPhone',
    'recruitmentContactName', 'recruitmentContactDesignation', 'recruitmentContactEmail', 'recruitmentContactPhone',
    // Legal & Finance
    'gst', 'pan', 'tan', 'businessType', 'paymentTerms', 'guaranteePeriod', 'invoiceTrigger',
    'paymentDue', 'commercialNotes', 'accountManager', 'bdeOwner',
    // Agreement
    'agreementRequired', 'agreementTemplate', 'agreementStart', 'agreementEnd',
    // Risk Monitoring
    'riskFlag', 'riskNotes',
  ],
  numeric: ['agreementFeePercent', 'tdsPercent', 'gstPercent'],
};

function pickClient(body) {
  const data = {};
  for (const key of CLIENT_FIELDS.text) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  for (const key of CLIENT_FIELDS.numeric) {
    if (body[key] !== undefined && body[key] !== '') data[key] = Number(body[key]);
  }
  return data;
}

// Human-readable client code (CLI0001 …), assigned at creation if the form
// did not supply one. It is what the Client Detail header shows.
async function nextClientCode() {
  const used = await prisma.client.count();
  for (let n = used + 1; n < used + 500; n += 1) {
    const code = `CLI${String(n).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await prisma.client.findFirst({ where: { clientCode: code }, select: { id: true } });
    if (!clash) return code;
  }
  return `CLI${Date.now()}`;
}

router.post('/', requirePerm('ats', 'clients', 'Add Client', 'create'), async (req, res) => {
  const data = pickClient(req.body);
  // Prototype saveNewClient(): the full save requires company name, location
  // and the three primary-contact fields. Saving as a draft skips the checks.
  const asDraft = Boolean(req.body.asDraft);
  if (!data.name) return res.status(400).json({ error: 'Enter the company name.' });
  if (!asDraft) {
    if (!data.state) return res.status(400).json({ error: 'Select the client location (State/District/City).' });
    if (!data.contactName || !data.contactEmail || !data.contactPhone) {
      return res.status(400).json({ error: 'Enter the primary contact name, phone and email.' });
    }
  }
  if (!data.clientCode) data.clientCode = await nextClientCode();

  const client = await prisma.client.create({ data: { ...data, agreementStatus: 'DRAFT' } });
  // "Save & Create Agreement" generates the document straight away from the
  // commercial terms; it still starts life as a Draft.
  const withDoc = req.body.createAgreement
    ? await prisma.client.update({
      where: { id: client.id },
      data: { agreementDocument: buildAgreementDocument(client), agreementSource: 'Generated' },
    })
    : client;
  await logAudit({ userId: req.user.id, action: 'Client created', entity: 'Client', entityId: client.id, toValue: 'Draft' });
  res.status(201).json(shapeClient(withDoc, await clientPermissions(req.user)));
});

router.put('/:id', requirePerm('ats', 'clients', 'Client Detail', 'edit'), async (req, res) => {
  const client = await prisma.client.update({ where: { id: req.params.id }, data: pickClient(req.body) });
  await logAudit({ userId: req.user.id, action: 'Client updated', entity: 'Client', entityId: client.id });
  res.json(shapeClient(client, await clientPermissions(req.user)));
});

// ---- Service agreement lifecycle -------------------------------------------
//
//   Add Client -> GST / TDS / Payment Terms -> Agreement -> Preview
//     -> Upload / Generate -> Send to Client -> Client View
//     -> Client Confirmation / Signed Copy -> Agreement Active
//
// Statuses: DRAFT · SENT · VIEWED · CLIENT_CONFIRMATION_PENDING · SIGNED ·
//           ACTIVE · EXPIRED · REJECTED
//
// SIGNED and ACTIVE stay deliberately distinct: the client signing the
// document signs it, and TeamLink then activates it. Only an ACTIVE agreement
// lets a requirement for that client go live (see routes/requirements.js).
//
// CONFIRMED / CANCELLED are the pre-clireq spellings; normalizeAgreementStatus
// folds them into SIGNED / REJECTED on read, so an existing database keeps
// working and nothing writes them again.

// The states from which a document may still be (re)generated or uploaded.
const OPEN_FOR_AUTHORING = ['DRAFT', 'SENT', 'VIEWED', 'REJECTED', 'EXPIRED'];
// The states a client may still be asked to sign from.
const OUT_FOR_SIGNATURE = ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'];

function statusOf(client) {
  return normalizeAgreementStatus(client.agreementStatus);
}

async function agreementTransition(req, res, { id, from, data, action, to }) {
  const client = await prisma.client.findUnique({ where: { id } });
  const current = statusOf(client);
  if (from && !from.includes(current)) {
    return res.status(400).json({ error: `An agreement in "${current}" cannot be ${action}.` });
  }
  const updated = await prisma.client.update({ where: { id }, data });
  await logAudit({
    userId: req.user.id, action, entity: 'Client', entityId: id, fromValue: current, toValue: to || current,
  });
  return res.json(shapeClient(updated, await clientPermissions(req.user)));
}

// Generate the document from the client's own commercial terms.
router.post('/:id/agreement/generate', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const client = req.client;
  if (agreementIsSigned(client.agreementStatus)) {
    return res.status(400).json({ error: 'This agreement is already signed — it cannot be regenerated' });
  }
  return agreementTransition(req, res, {
    id: client.id,
    from: OPEN_FOR_AUTHORING,
    action: 'Agreement document generated',
    to: 'DRAFT',
    data: {
      agreementDocument: buildAgreementDocument(client),
      agreementStatus: 'DRAFT',
      agreementSource: 'Generated',
      agreementRejectedAt: null,
      agreementRejectedReason: null,
    },
  });
});

// Upload a countersigned / negotiated document instead of generating one.
// The text arrives in the body — there is no file store in this app, and a
// base64 blob in SQLite would be a worse lie than storing the text.
router.post('/:id/agreement/upload', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const { document, fileName } = req.body;
  if (!String(document || '').trim()) {
    return res.status(400).json({ error: 'Paste or upload the agreement text to store it.' });
  }
  if (agreementIsSigned(req.client.agreementStatus)) {
    return res.status(400).json({ error: 'This agreement is already signed — upload a signed copy instead' });
  }
  return agreementTransition(req, res, {
    id: req.client.id,
    from: OPEN_FOR_AUTHORING,
    action: 'Agreement document uploaded',
    to: 'DRAFT',
    data: {
      agreementDocument: String(document),
      agreementStatus: 'DRAFT',
      agreementSource: 'Uploaded',
      agreementSignedCopyName: fileName || null,
    },
  });
});

router.post('/:id/agreement/send', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const client = req.client;
  if (!client.agreementDocument) return res.status(400).json({ error: 'Generate or upload the agreement document first' });
  if (agreementIsSigned(client.agreementStatus)) {
    return res.status(400).json({ error: 'This agreement is already signed' });
  }
  const current = statusOf(client);
  if (!OPEN_FOR_AUTHORING.includes(current)) {
    return res.status(400).json({ error: `An agreement in "${current}" cannot be sent.` });
  }

  const updated = await prisma.client.update({
    where: { id: client.id },
    data: {
      agreementStatus: 'SENT',
      agreementSentAt: new Date(),
      agreementViewedAt: null,
      agreementId: client.agreementId || (await nextAgreementId()),
      esignToken: client.esignToken || newEsignToken(),
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Agreement sent to client', entity: 'Client',
    entityId: client.id, fromValue: current, toValue: 'SENT',
  });

  // The client's own users get an in-app prompt; the signing link is what an
  // email/WhatsApp dispatch would carry (dispatch itself is out of scope).
  const clientUsers = await prisma.user.findMany({ where: { clientId: client.id, role: 'CLIENT' } });
  await notifyUsers(clientUsers.map((u) => u.id), {
    title: 'Service agreement ready to sign',
    message: `${client.name}: please review and e-sign agreement ${updated.agreementId}.`,
    exceptUserId: req.user.id,
  });

  res.json({
    ...shapeClient(updated, await clientPermissions(req.user)),
    signingPath: `/agreement/${updated.esignToken}`,
  });
});

// Client View — the client opened the document. Recorded from inside the app
// by the client's own login; routes/public.js does the same for the tokenised
// link. SENT -> VIEWED, and never backwards.
router.post('/:id/agreement/view', async (req, res) => {
  const client = req.client;
  if (statusOf(client) !== 'SENT') return res.json(shapeClient(client, await clientPermissions(req.user)));
  return agreementTransition(req, res, {
    id: client.id,
    from: ['SENT'],
    action: 'Agreement viewed by client',
    to: 'VIEWED',
    data: { agreementStatus: 'VIEWED', agreementViewedAt: client.agreementViewedAt || new Date() },
  });
});

// Ask the client to confirm — the explicit "Client Confirmation Pending" step
// between the client having read it and the client having signed it.
router.post('/:id/agreement/request-confirmation', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const clientUsers = await prisma.user.findMany({ where: { clientId: req.client.id, role: 'CLIENT' } });
  await notifyUsers(clientUsers.map((u) => u.id), {
    title: 'Please confirm your service agreement',
    message: `${req.client.name}: ${req.client.agreementId || 'the agreement'} is awaiting your confirmation.`,
    exceptUserId: req.user.id,
  });
  return agreementTransition(req, res, {
    id: req.client.id,
    from: ['SENT', 'VIEWED'],
    action: 'Client confirmation requested',
    to: 'CLIENT_CONFIRMATION_PENDING',
    data: { agreementStatus: 'CLIENT_CONFIRMATION_PENDING', agreementConfirmationRequestedAt: new Date() },
  });
});

// Signed from inside the app by the client's own login (the public link route
// in routes/public.js is the no-login equivalent).
router.post('/:id/agreement/confirm', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'approve'), async (req, res) => {
  const client = req.client;
  const current = statusOf(client);
  if (!OUT_FOR_SIGNATURE.includes(current)) {
    return res.status(400).json({ error: 'No pending agreement to sign' });
  }

  const { signedByName, signedByTitle, signedCopyName } = req.body;
  const updated = await prisma.client.update({
    where: { id: client.id },
    data: {
      agreementStatus: 'SIGNED',
      agreementSignedAt: new Date(),
      agreementSignedBy: signedByName || req.user.name,
      agreementSignedByTitle: signedByTitle || null,
      agreementSignedCopyName: signedCopyName || client.agreementSignedCopyName || null,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Agreement signed by client', entity: 'Client',
    entityId: client.id, fromValue: current, toValue: 'SIGNED',
  });

  // Let the account team know the agreement came back signed.
  const owners = await prisma.requirement.findMany({
    where: { clientId: client.id },
    select: { recruiterId: true, bdeId: true, tlId: true },
  });
  await notifyUsers(owners.flatMap((r) => [r.recruiterId, r.bdeId, r.tlId]), {
    title: `${client.name} signed the service agreement`,
    message: `${updated.agreementId || 'Agreement'} signed by ${updated.agreementSignedBy}.`,
    exceptUserId: req.user.id,
  });

  res.json(shapeClient(updated, await clientPermissions(req.user)));
});

// The client declines. Terminal until the document is regenerated.
router.post('/:id/agreement/reject', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'approve'), async (req, res) => (
  agreementTransition(req, res, {
    id: req.client.id,
    from: OUT_FOR_SIGNATURE,
    action: 'Agreement rejected by client',
    to: 'REJECTED',
    data: {
      agreementStatus: 'REJECTED',
      agreementRejectedAt: new Date(),
      agreementRejectedReason: req.body.reason || null,
    },
  })
));

// Attach the countersigned copy the client returned out of band.
router.post('/:id/agreement/signed-copy', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const { fileName, note } = req.body;
  if (!String(fileName || '').trim()) return res.status(400).json({ error: 'Name the signed copy you are attaching.' });
  return agreementTransition(req, res, {
    id: req.client.id,
    from: [...OUT_FOR_SIGNATURE, 'SIGNED', 'ACTIVE'],
    action: 'Signed copy attached',
    data: { agreementSignedCopyName: fileName, agreementSignedCopyNote: note || null },
  });
});

// Resend an agreement already out for signature — the prototype's
// resendAgreement() (line 7981). The status does not move.
router.post('/:id/agreement/resend', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const current = statusOf(req.client);
  if (!OUT_FOR_SIGNATURE.includes(current)) {
    return res.status(400).json({ error: 'No agreement is currently out for signature' });
  }
  const updated = await prisma.client.update({ where: { id: req.client.id }, data: { agreementSentAt: new Date() } });
  await logAudit({
    userId: req.user.id, action: 'Agreement resent to client', entity: 'Client',
    entityId: req.client.id, fromValue: current, toValue: current,
  });
  res.json({
    ...shapeClient(updated, await clientPermissions(req.user)),
    signingPath: `/agreement/${updated.esignToken}`,
  });
});

// The final step: TeamLink activates the signed agreement, which is what
// unblocks requirements for this client. Signing alone is not enough.
router.post('/:id/agreement/activate', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const client = req.client;
  if (agreementIsActive(client.agreementStatus)) return res.status(400).json({ error: 'This agreement is already Active' });
  if (statusOf(client) !== 'SIGNED') {
    return res.status(400).json({ error: 'Only a Signed agreement can be activated' });
  }
  const updated = await prisma.client.update({
    where: { id: client.id },
    data: { agreementStatus: 'ACTIVE', agreementActivatedAt: new Date() },
  });
  await logAudit({
    userId: req.user.id, action: 'Agreement activated', entity: 'Client',
    entityId: client.id, fromValue: 'SIGNED', toValue: 'ACTIVE',
  });

  // Every requirement parked at the agreement gate can now be opened. They are
  // not force-opened: the gate simply stops refusing.
  const waiting = await prisma.requirement.count({
    where: { clientId: client.id, status: { in: ['DRAFT', 'AGREEMENT_CHECK'] } },
  });
  res.json({ ...shapeClient(updated, await clientPermissions(req.user)), requirementsWaiting: waiting });
});

// Expire an agreement past its end date. Client requirements stop going live.
router.post('/:id/agreement/expire', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => (
  agreementTransition(req, res, {
    id: req.client.id,
    from: ['ACTIVE', 'SIGNED'],
    action: 'Agreement expired',
    to: 'EXPIRED',
    data: { agreementStatus: 'EXPIRED' },
  })
));

module.exports = router;
