const express = require('express');
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { inspectSetPasswordToken, redeemSetPasswordToken } = require('../utils/employeeInvite');
const { findCandidateByContact } = require('../utils/jobPortalBridge');

const {
  REQUIREMENT_LIVE_STATUSES, requirementIsLive, normalizeAgreementStatus, agreementIsSigned,
  PORTAL_APPLICATION_SOURCE,
} = require('../utils/atsVocab');

const router = express.Router();

// Public job listing — the TeamLink Job Portal candidates browse without logging in.
const PUBLIC_COMPANY = 'TeamLink Consultants';

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
      // THE CLIENT STAYS CONFIDENTIAL on anything public — the same rule the
      // job feeds below follow. The company advertising is TeamLink.
      client: PUBLIC_COMPANY,
      location: j.location || j.client.location,
      postedAt: j.createdAt,
      // Whether someone in the ATS has PUBLISHED this requirement to the job
      // portal. Reported, deliberately NOT used as a filter: this feed has
      // always listed every live requirement, and narrowing it now would
      // empty the careers list on any database seeded before publishing
      // existed. See the migration's backfill and JobPortalWorkspace.jsx,
      // which both say the same thing.
      published: !!j.portalPublished,
    }))
  );
});

// ---------------------------------------------------------------------------
// JOB FEEDS — for job boards and for tmlink.in.
//
//   GET /api/public/jobs.xml    the Indeed-format XML feed (Shine and most
//                               Indian boards read the same shape): register
//                               this URL in the board's employer account and
//                               it collects new openings itself
//   GET /api/public/jobs.feed   the same openings as JSON, for a "Current
//                               openings" section on the company website
//
// ONLY what someone has PUBLISHED to the TeamLink Job Portal, and only while
// it is live — the feed is a deliberate act, not every requirement in the ATS.
// The company named is TeamLink Consultants, never the client: who the client
// is stays confidential, as it is on every recruitment agency's listings.
// ---------------------------------------------------------------------------
function publicBase(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`.replace(':4010', ':5183');
}

async function feedJobs() {
  return prisma.requirement.findMany({
    where: { status: { in: REQUIREMENT_LIVE_STATUSES }, portalPublished: true },
    orderBy: { portalPublishedAt: 'desc' },
  });
}

const listOf = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
function feedDescription(j) {
  return [
    j.jobDescription || j.description || '',
    j.responsibilities ? `Responsibilities:\n${j.responsibilities}` : '',
    j.qualifications ? `Qualifications:\n${j.qualifications}` : '',
    listOf(j.skills).length ? `Skills: ${listOf(j.skills).join(', ')}` : '',
    j.experience ? `Experience: ${j.experience}` : '',
  ].filter(Boolean).join('\n\n');
}
// XML 1.0 forbids most control characters even inside CDATA; one pasted from
// a Word JD makes the WHOLE feed unparseable for every board, so they go.
// eslint-disable-next-line no-control-regex
const xmlSafe = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
const cdata = (v) => `<![CDATA[${xmlSafe(v).split(']]>').join(']]]]><![CDATA[>')}]]>`;

router.get('/jobs.xml', async (req, res) => {
  const base = publicBase(req);
  // External job boards get client openings only: a TeamLink internal hire
  // stays on TeamLink's own channels (portal, careers page, website feed).
  const jobs = (await feedJobs()).filter((j) => !j.internal);
  const items = jobs.map((j) => `  <job>
    <title>${cdata(j.title)}</title>
    <date>${cdata(new Date(j.portalPublishedAt || j.createdAt).toUTCString())}</date>
    <referencenumber>${cdata(j.reqCode || j.id)}</referencenumber>
    <url>${cdata(`${base}/careers/${j.id}`)}</url>
    <company>${cdata('TeamLink Consultants')}</company>
    <city>${cdata(j.location || '')}</city>
    <state>${cdata('')}</state>
    <country>${cdata('IN')}</country>
    <description>${cdata(feedDescription(j))}</description>
    <salary>${cdata(j.salary && j.salary !== '—' ? j.salary : '')}</salary>
    <jobtype>${cdata(j.employmentType || '')}</jobtype>
    <category>${cdata(j.department || '')}</category>
    <experience>${cdata(j.experience || '')}</experience>
  </job>`).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<source>
  <publisher>TeamLink Consultants</publisher>
  <publisherurl>https://tmlink.in</publisherurl>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</source>
`);
});

router.get('/jobs.feed', async (req, res) => {
  const base = publicBase(req);
  // Only jobs with "Website" ticked (utils/jobPosting.js; nothing ticked = the free sites).
  // eslint-disable-next-line global-require
  const jobs = (await feedJobs()).filter((j) => require('../utils/jobPosting').siteTicked(j, 'website'));
  res.set('Access-Control-Allow-Origin', '*');
  res.json(jobs.map((j) => ({
    id: j.id,
    reference: j.reqCode || null,
    title: j.title,
    department: j.department,
    location: j.location || null,
    experience: j.experience || null,
    employmentType: j.employmentType || null,
    workMode: j.workMode || null,
    skills: listOf(j.skills),
    description: feedDescription(j),
    postedAt: j.portalPublishedAt || j.createdAt,
    applyUrl: `${base}/careers/${j.id}?src=TeamLink%20Website`,
  })));
});

// GET /api/public/jobs.jsonld — the same client openings as schema.org
// JobPosting objects (the structure Google for Jobs and most aggregators
// read). Pull-based like jobs.xml: nothing is pushed anywhere.
const EMPLOYMENT_TYPE = {
  'full time': 'FULL_TIME', 'part time': 'PART_TIME', contract: 'CONTRACTOR', contractual: 'CONTRACTOR',
  temporary: 'TEMPORARY', internship: 'INTERN', intern: 'INTERN', freelance: 'CONTRACTOR',
};
router.get('/jobs.jsonld', async (req, res) => {
  const base = publicBase(req);
  // Only client jobs with "Google Jobs" ticked (utils/jobPosting.js).
  // eslint-disable-next-line global-require
  const jobs = (await feedJobs()).filter((j) => !j.internal && require('../utils/jobPosting').siteTicked(j, 'google'));
  res.set('Access-Control-Allow-Origin', '*');
  res.type('application/ld+json').send(JSON.stringify(jobs.map((j) => jobPostingLd(j, base)), null, 1));
});

// ONE job's JobPosting, for the careers page to embed as <script
// type="application/ld+json"> — Google for Jobs reads the markup on the job's
// own page. 404 unless the job is live, published, a client job and has
// "Google Jobs" ticked.
router.get('/jobs/:id/jsonld', async (req, res) => {
  // An id or a readable slug (utils/jobSlug.js).
  const j = await require('../utils/jobSlug').findByIdOrSlug(req.params.id); // eslint-disable-line global-require
  // eslint-disable-next-line global-require
  const ok = j && !j.internal && j.portalPublished && requirementIsLive(j.status) && require('../utils/jobPosting').siteTicked(j, 'google');
  if (!ok) return res.status(404).json({ error: 'Not listed' });
  return res.type('application/ld+json').send(JSON.stringify(jobPostingLd(j, publicBase(req))));
});

function jobPostingLd(j, base) {
  {
    const posted = new Date(j.portalPublishedAt || j.createdAt);
    const closing = j.closingDate && !Number.isNaN(new Date(j.closingDate).getTime()) ? new Date(j.closingDate) : null;
    const remote = /remote/i.test(String(j.workMode || ''));
    return {
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: j.title,
      description: feedDescription(j).replace(/\n/g, '<br>'),
      identifier: { '@type': 'PropertyValue', name: PUBLIC_COMPANY, value: j.reqCode || j.id },
      datePosted: posted.toISOString().slice(0, 10),
      ...(closing && closing > posted ? { validThrough: closing.toISOString() } : {}),
      employmentType: EMPLOYMENT_TYPE[String(j.employmentType || '').toLowerCase()] || 'FULL_TIME',
      hiringOrganization: { '@type': 'Organization', name: PUBLIC_COMPANY, sameAs: 'https://tmlink.in' },
      jobLocation: {
        '@type': 'Place',
        address: { '@type': 'PostalAddress', addressLocality: j.location || 'India', addressCountry: 'IN' },
      },
      ...(remote ? { jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { '@type': 'Country', name: 'India' } } : {}),
      ...(j.department ? { occupationalCategory: j.department } : {}),
      ...(j.experience ? { experienceRequirements: j.experience } : {}),
      ...(listOf(j.skills).length ? { skills: listOf(j.skills).join(', ') } : {}),
      directApply: true,
      url: `${base}${require('../utils/jobSlug').careersPath(j, 'Google Jobs')}`, // eslint-disable-line global-require
    };
  }
}

router.get('/jobs/:id', async (req, res) => {
  const job = await prisma.requirement.findUnique({ where: { id: req.params.id }, include: { client: true } });
  if (!job || !requirementIsLive(job.status)) return res.status(404).json({ error: 'Job not found' });
  res.json({
    id: job.id,
    title: job.title,
    description: job.description,
    department: job.department,
    priority: job.priority,
    client: PUBLIC_COMPANY,
    location: job.location || job.client.location,
    postedAt: job.createdAt,
  });
});

// Candidate applies from the public portal — creates (or reuses) a Candidate record
// and links a new Application into the pipeline at the NEW stage.
// The job board or channel an applicant came through, from the apply link's
// ?src= tag (the requirement page tags each source's link). Only these names
// are accepted; anything else counts as the Job Portal itself.
const TRACKED_SOURCES = ['Naukri', 'Indeed', 'Shine', 'LinkedIn', 'Facebook', 'WhatsApp', 'X', 'TeamLink Website', 'Google Jobs'];

router.post('/jobs/:id/apply', async (req, res) => {
  const { name, email, phone } = req.body;
  const cameFrom = TRACKED_SOURCES.includes(String(req.body.src || '')) ? String(req.body.src) : null;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  const job = await prisma.requirement.findUnique({ where: { id: req.params.id } });
  if (!job || !requirementIsLive(job.status)) return res.status(404).json({ error: 'Job not found' });
  // A paused / archived client takes no new applications (spec 2026-10-03 §A).
  // The public is not told why.
  // eslint-disable-next-line global-require
  if (!job.internal && await require('../utils/clientLifecycle').newWorkRefusalFor(job.clientId)) {
    return res.status(409).json({ error: 'This job is not accepting applications right now.' });
  }

  // ONE CANDIDATE MASTER: an applicant already on file — by the normalised
  // email or phone (utils/candidateDedupe.js keys, as the Add Candidate form
  // and the portal import use) — applies as that candidate, never as a copy.
  let candidate = await findCandidateByContact({ email, phone });
  if (!candidate) {
    candidate = await prisma.candidate.create({ data: { name, email: String(email).trim(), phone: phone ? String(phone).trim() : null, source: cameFrom || 'Job Portal' } });
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

  // SOURCE IS STAMPED, NOT INFERRED. An application that arrives through this
  // form carries source = "TeamLink Job Portal" on the APPLICATION, which is
  // what the internal Job Portal workspace lists and what "Import to ATS"
  // checks (routes/jobPortal.js). Reading it off the candidate instead would
  // mis-attribute every later application by the same person.
  const application = await prisma.application.create({
    data: {
      candidateId: candidate.id,
      requirementId: job.id,
      stage: 'NEW',
      source: PORTAL_APPLICATION_SOURCE,
      // WHERE THEY SAW THE JOB — Shine, Naukri, LinkedIn … — from the tagged
      // apply link. This is what proves a posting on that board is live: the
      // requirement page counts these per source.
      firstSource: cameFrom || PORTAL_APPLICATION_SOURCE,
      applicationMethod: 'Auto-Apply',
    },
  });
  // b6_ (ATS-100): the apply link's utm_* / ?ref=<code>, on the application.
  try {
    // eslint-disable-next-line global-require
    const CR = require('../utils/candidateRecord');
    if (CR.supported()) await CR.attach({ application, candidate, utm: req.body, refCode: req.body.ref, via: 'LINK' });
  } catch (err) { console.error(`[public] source not stored for ${application.id}: ${err.message}`); }
  await prisma.syncLog.create({
    data: { entity: 'Applications', status: 'Success', reason: `${candidate.name} → ${job.title}`, recordRef: application.id },
  });
  await logAudit({ action: 'Job Portal application received', entity: 'Application', entityId: application.id, toValue: candidate.name });

  res.status(201).json({ message: 'Application submitted', applicationId: application.id });
});

// The old no-login status lookup by email (see below — now closed).
router.get('/my-applications', (req, res) => {
  // CLOSED (user notes #4). This answered anyone who typed an email with that
  // person's applications and employers. A candidate now signs in to their own
  // portal; the public page mails a one-time sign-in link instead
  // (POST /api/portal/public/claim, routes/portal.js). Nothing is looked up here.
  res.status(410).json({ error: 'For your privacy, application status is shown only after you sign in. Use "Get my sign-in link" with the email you applied with.' });
});

// ---- Client agreement signing link -----------------------------------------
// The tokenised link a client receives (POST /api/clients/:id/agreement/send,
// which also emails / texts / WhatsApps it). Outside the login wall so the
// signatory needs no TeamLink account — the opaque token is the only thing
// that grants access, it exposes that one client's agreement only, it EXPIRES
// (utils/agreementSigning.js LINK_DAYS) and every resend replaces it.
//
// The signing itself — OK Proceed, e-signature, OTP to the registered mobile,
// submit — is in routes/agreementSeal.js under /api/agreement/token/:token.
// The old one-step "type your name to sign" route is gone: it signed an
// agreement with no signature image and no OTP.

// Rate-limited per IP (utils/publicRateLimit.js); the token is stored hashed
// (utils/agreementSigning.js findByToken).
// eslint-disable-next-line global-require
const agreementLinkLimit = require('../utils/publicRateLimit').rateLimit({ bucket: 'agreement-open', max: 60, windowMs: 10 * 60000 });
router.get('/agreement/:token', agreementLinkLimit, async (req, res) => {
  // eslint-disable-next-line global-require
  const signing = require('../utils/agreementSigning');
  const client = await signing.findByToken(req.params.token);
  const link = signing.linkState(client);
  if (!link.ok) return res.status(link.code).json({ error: link.error, expired: link.code === 410 && !link.revoked, revoked: !!link.revoked });

  // Opening the link is a step: SENT -> VIEWED the first time, audited.
  let current = client;
  if (normalizeAgreementStatus(client.agreementStatus) === 'SENT') {
    current = await prisma.client.update({
      where: { id: client.id },
      data: { agreementStatus: 'VIEWED', agreementViewedAt: client.agreementViewedAt || new Date() },
    });
    await logAudit({
      action: signing.ACTION.opened, entity: 'Client', entityId: client.id, fromValue: 'SENT', toValue: 'VIEWED',
      reason: `IP ${String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 60)}`,
    });
  }
  return res.json(await signing.publicView(current));
});

router.post('/agreement/:token/sign', (req, res) => res.status(410).json({
  error: 'Signing now happens on the agreement page: read it, press OK, Proceed, sign, and confirm with the code sent to your registered mobile.',
}));

// ---- Set your password (new employee sign-in link) -------------------------
// The link HR's "your sign-in details" mail carries. Outside the login wall by
// necessity — the employee has no password yet. The opaque, single-use,
// expiring token is the only thing that grants access, and it grants exactly
// one thing: setting that one login's password. See utils/employeeInvite.js;
// no password is ever emailed, echoed or logged.

// A CANDIDATE portal invite is not redeemable here: its link must prove the
// email with a one-time code first (routes/portalPublic.js, spec B2).
async function isCandidateInvite(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return false;
  const hash = require('crypto').createHash('sha256').update(String(token)).digest('hex'); // eslint-disable-line global-require
  const u = await prisma.user.findFirst({ where: { setPasswordTokenHash: hash }, select: { role: true } });
  return !!(u && u.role === 'CANDIDATE');
}

router.get('/set-password/:token', async (req, res) => {
  if (await isCandidateInvite(req.params.token)) return res.json({ portalInvite: true, path: `/portal-invite/${req.params.token}` });
  const info = await inspectSetPasswordToken(req.params.token);
  if (!info.ok) return res.status(404).json({ error: info.reason });
  res.json({ name: info.name, email: info.email, expiresAt: info.expiresAt });
});

router.post('/set-password/:token', async (req, res) => {
  if (await isCandidateInvite(req.params.token)) {
    return res.status(409).json({ error: 'Open this link on the portal invite page — your email must be confirmed with a code first.' });
  }
  const result = await redeemSetPasswordToken(req.params.token, req.body && req.body.password);
  if (!result.ok) {
    return res.status(result.code === 'weak' ? 400 : 410).json({ error: result.reason });
  }
  // The audit trail records THAT a password was set, never the password.
  const user = await prisma.user.findUnique({ where: { email: result.email } });
  await logAudit({ userId: user ? user.id : null, action: 'Password set via sign-in link', entity: 'User', entityId: user ? user.id : null });
  res.json({ message: 'Password set — you can sign in now.', email: result.email });
});

// ---------------------------------------------------------------------------
// The public home page's contact card. READ-ONLY and deliberately narrow: the
// Company row also holds GSTIN, PAN, TAN and bank details, and none of that
// may reach an anonymous visitor — so the five fields are picked by name, never
// spread from the row.
// ---------------------------------------------------------------------------
router.get('/company-contact', async (req, res) => {
  const c = await prisma.company.findFirst({
    select: { name: true, legalName: true, address: true, email: true, phone: true },
  }).catch(() => null);
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // Seed/demo values (hello@teamlink.test, +91 40 1234 5678) must never be
  // published as the company's real contact details — leave them out instead.
  const realEmail = (v) => {
    const e = clean(v);
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
    return /@(example\.(com|org|net)|[^@]*\.(test|example|invalid|localhost|local))$/i.test(e) ? null : e;
  };
  const realPhone = (v) => {
    const p = clean(v);
    if (!p) return null;
    const digits = p.replace(/\D/g, '');
    return digits.length < 8 || /12345678|00000000|98765432/.test(digits) ? null : p;
  };
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    name: clean(c && (c.legalName || c.name)) || 'TeamLink Consultants',
    address: clean(c && c.address),
    email: realEmail(c && c.email),
    phone: realPhone(c && c.phone),
    website: 'https://tmlink.in',
  });
});

module.exports = router;
