const express = require('express');
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { inspectSetPasswordToken, redeemSetPasswordToken } = require('../utils/employeeInvite');

const {
  REQUIREMENT_LIVE_STATUSES, requirementIsLive, normalizeAgreementStatus, agreementIsSigned,
} = require('../utils/atsVocab');

const router = express.Router();

// Public job listing — the TeamLink Job Portal candidates browse without logging in.
router.get('/jobs', async (req, res) => {
  const jobs = await prisma.requirement.findMany({
    where: { status: { in: REQUIREMENT_LIVE_STATUSES } },
    include: { client: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(
    jobs.map((j) => ({
      id: j.id,
      title: j.title,
      description: j.description,
      department: j.department,
      priority: j.priority,
      client: j.client.name,
      location: j.client.location,
      postedAt: j.createdAt,
    }))
  );
});

router.get('/jobs/:id', async (req, res) => {
  const job = await prisma.requirement.findUnique({ where: { id: req.params.id }, include: { client: true } });
  if (!job || !requirementIsLive(job.status)) return res.status(404).json({ error: 'Job not found' });
  res.json({
    id: job.id,
    title: job.title,
    description: job.description,
    department: job.department,
    priority: job.priority,
    client: job.client.name,
    location: job.client.location,
    postedAt: job.createdAt,
  });
});

// Candidate applies from the public portal — creates (or reuses) a Candidate record
// and links a new Application into the pipeline at the NEW stage.
router.post('/jobs/:id/apply', async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  const job = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!job || !requirementIsLive(job.status)) return res.status(404).json({ error: 'Job not found' });

  let candidate = await prisma.candidate.findFirst({ where: { email } });
  if (!candidate) {
    candidate = await prisma.candidate.create({ data: { name, email, phone, source: 'Job Portal' } });
    await prisma.syncLog.create({
      data: { entity: 'Candidates', status: 'Success', reason: `${candidate.name} registered from the Job Portal`, recordRef: candidate.id },
    });
  }

  const existing = await prisma.application.findUnique({
    where: { candidateId_requirementId: { candidateId: candidate.id, requirementId: job.id } },
  });
  if (existing) {
    // Administration -> Integrations -> Job Portal Synchronisation shows every
    // record that came across, failures included.
    await prisma.syncLog.create({
      data: { entity: 'Applications', status: 'Failed', reason: 'Duplicate application — this candidate already applied to this job', recordRef: existing.id },
    });
    return res.status(409).json({ error: 'You have already applied to this job' });
  }

  const application = await prisma.application.create({ data: { candidateId: candidate.id, requirementId: job.id, stage: 'NEW' } });
  await prisma.syncLog.create({
    data: { entity: 'Applications', status: 'Success', reason: `${candidate.name} → ${job.title}`, recordRef: application.id },
  });
  await logAudit({ action: 'Job Portal application received', entity: 'Application', entityId: application.id, toValue: candidate.name });

  res.status(201).json({ message: 'Application submitted', applicationId: application.id });
});

// Candidate portal — where an applicant checks what happened to the
// applications they submitted, keyed on the email they applied with (no
// account, matching the no-login apply flow above). The prototype's
// candidatePortalView()/myApplications().
router.get('/my-applications', async (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email is required' });

  const candidate = await prisma.candidate.findFirst({
    where: { email },
    include: {
      applications: {
        include: { requirement: { include: { client: true } } },
        orderBy: { updatedAt: 'desc' },
      },
    },
  });
  if (!candidate) return res.json({ name: null, applications: [] });

  res.json({
    name: candidate.name,
    applications: candidate.applications.map((a) => ({
      id: a.id,
      jobTitle: a.requirement.title,
      client: a.requirement.client.name,
      location: a.requirement.client.location,
      stage: a.stage,
      interviewAt: a.interviewAt,
      appliedAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
  });
});

// ---- Client agreement signing link -----------------------------------------
// The tokenised link a client receives (see POST /api/clients/:id/agreement/send).
// It is deliberately outside the login wall so the signatory doesn't need a
// TeamLink account — the opaque token is the only thing that grants access,
// and it exposes nothing beyond that one client's own agreement.

router.get('/agreement/:token', async (req, res) => {
  const client = await prisma.client.findUnique({ where: { esignToken: req.params.token } });
  if (!client || !client.agreementDocument) {
    return res.status(404).json({ error: 'This signing link is not valid — ask TeamLink to resend it' });
  }

  // Client View is a real step of the workflow now: SENT -> VIEWED, recorded
  // with a timestamp the first time the signatory opens the link.
  let status = normalizeAgreementStatus(client.agreementStatus);
  if (status === 'SENT') {
    await prisma.client.update({
      where: { id: client.id },
      data: { agreementStatus: 'VIEWED', agreementViewedAt: client.agreementViewedAt || new Date() },
    });
    await logAudit({ action: 'Agreement viewed by client', entity: 'Client', entityId: client.id, fromValue: 'SENT', toValue: 'VIEWED' });
    status = 'VIEWED';
  }

  res.json({
    clientName: client.name,
    agreementId: client.agreementId,
    document: client.agreementDocument,
    status,
    signedAt: client.agreementSignedAt,
    signedBy: client.agreementSignedBy,
    signedByTitle: client.agreementSignedByTitle,
  });
});

router.post('/agreement/:token/sign', async (req, res) => {
  const { signedByName, signedByTitle } = req.body;
  if (!signedByName) return res.status(400).json({ error: 'Type your full name to sign' });

  const client = await prisma.client.findUnique({ where: { esignToken: req.params.token } });
  if (!client || !client.agreementDocument) {
    return res.status(404).json({ error: 'This signing link is not valid — ask TeamLink to resend it' });
  }
  const current = normalizeAgreementStatus(client.agreementStatus);
  if (agreementIsSigned(client.agreementStatus)) {
    return res.status(409).json({ error: 'This agreement has already been signed' });
  }
  // Sent, Viewed or Client Confirmation Pending are all signable states.
  if (!['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(current)) {
    return res.status(400).json({ error: 'This agreement has not been sent for signature' });
  }

  const updated = await prisma.client.update({
    where: { id: client.id },
    data: {
      agreementStatus: 'SIGNED',
      agreementSignedAt: new Date(),
      agreementSignedBy: signedByName,
      agreementSignedByTitle: signedByTitle || null,
    },
  });
  await logAudit({
    action: 'Agreement e-signed via signing link', entity: 'Client',
    entityId: client.id, fromValue: current, toValue: 'SIGNED',
  });

  const owners = await prisma.requirement.findMany({ where: { clientId: client.id }, select: { recruiterId: true, bdeId: true, tlId: true } });
  await notifyUsers(owners.flatMap((r) => [r.recruiterId, r.bdeId, r.tlId]), {
    title: `${client.name} signed the service agreement`,
    message: `${updated.agreementId || 'Agreement'} signed by ${signedByName}.`,
  });

  res.json({ message: 'Agreement signed', agreementId: updated.agreementId, signedAt: updated.agreementSignedAt });
});

// ---- Set your password (new employee sign-in link) -------------------------
// The link HR's "your sign-in details" mail carries. Outside the login wall by
// necessity — the employee has no password yet. The opaque, single-use,
// expiring token is the only thing that grants access, and it grants exactly
// one thing: setting that one login's password. See utils/employeeInvite.js;
// no password is ever emailed, echoed or logged.

router.get('/set-password/:token', async (req, res) => {
  const info = await inspectSetPasswordToken(req.params.token);
  if (!info.ok) return res.status(404).json({ error: info.reason });
  res.json({ name: info.name, email: info.email, expiresAt: info.expiresAt });
});

router.post('/set-password/:token', async (req, res) => {
  const result = await redeemSetPasswordToken(req.params.token, req.body && req.body.password);
  if (!result.ok) {
    return res.status(result.code === 'weak' ? 400 : 410).json({ error: result.reason });
  }
  // The audit trail records THAT a password was set, never the password.
  const user = await prisma.user.findUnique({ where: { email: result.email } });
  await logAudit({ userId: user ? user.id : null, action: 'Password set via sign-in link', entity: 'User', entityId: user ? user.id : null });
  res.json({ message: 'Password set — you can sign in now.', email: result.email });
});

module.exports = router;
