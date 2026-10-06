// ---------------------------------------------------------------------------
// The TeamLink Job Portal bridge — the real two-way sync (restored 2026-10-05).
//
// The Job Portal is the customer's own application (job-portal-app/
// job_portal-main, Express + PostgreSQL), kept exactly as supplied. It is
// EMBEDDED: this backend starts it and serves it at <this site>/jobs
// (utils/jobPortalEmbed.js). Its data stays in its own database; this module
// keeps the two in step, in seconds:
//
//   ATS -> portal   a requirement that is PUBLISHED, LIVE and has "Job Portal"
//                   ticked is a job on the portal, keyed tl_<requirement id>;
//                   anything else that was once published is closed there.
//                   Pushed at once on publish / unpublish / every requirement
//                   change (pushRequirement), and by fullSync on "Sync now",
//                   at startup and hourly.
//   portal -> ATS   an application made on the portal becomes a Candidate
//                   (deduplicated by email, then phone) and an Application at
//                   NEW, source "TeamLink Job Portal", with the resume it was
//                   made with — pushed by the portal the moment it is made
//                   (POST /api/public/job-portal/applications, routes/
//                   jobPortalBridge.js; job-portal-app/embed/teamlink-
//                   integration.mjs on the portal side), and pulled back by
//                   fullSync as a catch-up. Idempotent: one portal application
//                   is one pipeline row however often it arrives.
//
// Environment (backend/.env — names only, never values in logs):
//   APP_BASE_URL                 this site; the portal is <it>/jobs
//   JOB_PORTAL_PUBLIC_URL        override what browsers open (default <APP_BASE_URL>/jobs)
//   JOB_PORTAL_API_URL           override what this server calls (default the
//                                embedded portal, http://127.0.0.1:<JOB_PORTAL_PORT>)
//   JOB_PORTAL_SYNC_TOKEN        sent to the portal as x-teamlink-token
//   JOB_PORTAL_PUSH_SECRET       expected from the portal as x-job-portal-secret
//   JOB_PORTAL_SYNC_INTERVAL_MS  hourly by default; 0 switches the timer off
// (JOB_PORTAL_URL — the old separate :4323 address — is no longer read.)
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');
// The SAME normalisation the Candidate Master's duplicate guard uses
// (utils/candidateDedupe.js): phone = last ten digits of any number in the
// cell, email = first address-shaped token, lower-cased. A portal applicant
// who is already on file as "+91 98765 43210" / "Ravi@Gmail.com" is that
// candidate, not a new one.
const { phoneKeys, emailKey } = require('./candidateDedupe');
const {
  REQUIREMENT_LIVE_STATUSES, requirementIsLive, PORTAL_APPLICATION_SOURCE,
} = require('./atsVocab');

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
// eslint-disable-next-line global-require
const embed = () => require('./jobPortalEmbed');
// What a browser opens: the portal on this site, /jobs.
const portalUrl = () => trimSlash(process.env.JOB_PORTAL_PUBLIC_URL || `${trimSlash(process.env.APP_BASE_URL || 'http://localhost:5183')}${embed().BASE}`);
// What this server calls: the embedded portal on its internal port.
const portalApi = () => trimSlash(process.env.JOB_PORTAL_API_URL || embed().internalUrl());
const syncToken = () => process.env.JOB_PORTAL_SYNC_TOKEN || '';
const pushSecret = () => process.env.JOB_PORTAL_PUSH_SECRET || '';

const portalJobId = (requirementId) => `tl_${requirementId}`;
const requirementIdOf = (jobId) => (String(jobId || '').startsWith('tl_') ? String(jobId).slice(3) : null);
// The portal routes on the hash; ?src= is read by the portal (its
// teamlink-integration.js) and recorded as the application's source, which
// comes back here as firstSource.
// b6_: `extra` carries utm_source / utm_medium / utm_campaign / utm_content /
// ref (a referral code) through to the portal page, where the embed host
// (job-portal-app/embed/teamlink-integration.mjs) remembers them for the
// application. ?src= stays first: the portal reads the first tag it finds.
const PASS_THROUGH = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref'];
function jobUrl(requirementId, src, extra = null) {
  const q = new URLSearchParams();
  if (src) q.set('src', src);
  PASS_THROUGH.forEach((k) => { const v = extra && extra[k]; if (typeof v === 'string' && v.trim()) q.set(k, v.trim().slice(0, 100)); });
  const qs = q.toString();
  return `${portalUrl()}/${qs ? `?${qs}` : ''}#/job/${portalJobId(requirementId)}`;
}

function secretMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(pushSecret());
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- ATS -> portal --------------------------------------------------------

const lines = (v) => String(v || '').split(/\r?\n/).map((s) => s.replace(/^[\s•*-]+/, '').trim()).filter(Boolean);
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// The job's "Job Portal" tick (utils/jobPosting.js SITES). Lazy: jobPosting
// requires this module.
// eslint-disable-next-line global-require
const portalTicked = (r) => require('./jobPosting').siteTicked(r, 'jobportal');

function jobPayload(r) {
  const open = !!r.portalPublished && requirementIsLive(r.status) && portalTicked(r);
  const exp = r.experience ? (/yr|year/i.test(r.experience) ? r.experience : `${r.experience} yrs`) : null;
  // The portal's job card prints location / experience / salary as given;
  // a requirement without them would show "undefined" there. Plain words
  // instead — nothing is guessed.
  return {
    requirementId: r.id,
    reqCode: r.reqCode || null,
    title: r.title,
    location: r.location || 'Location not specified',
    mode: r.workMode || null,
    exp: exp || 'Experience not specified',
    pay: r.salary && r.salary !== '—' ? r.salary : 'Salary not disclosed',
    type: r.employmentType || null,
    department: r.department || null,
    education: r.education || null,
    openings: r.openings || 1,
    skills: csv(r.skills),
    desc: r.jobDescription || r.description || null,
    responsibilities: lines(r.responsibilities),
    requirements: lines(r.qualifications),
    status: open ? 'open' : 'closed',
  };
}

async function portalFetch(path, {
  method = 'GET', body, timeoutMs = 10000, raw = false,
} = {}) {
  if (!syncToken()) {
    const err = new Error('JOB_PORTAL_SYNC_TOKEN is not set in backend/.env');
    err.notConfigured = true;
    throw err;
  }
  // TEST SANDBOX: the portal is never contacted (utils/sandbox.js).
  if (require('./sandbox').isSandbox()) { // eslint-disable-line global-require
    const err = new Error('Job Portal sync is off in the TEST SANDBOX');
    err.notConfigured = true;
    throw err;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${portalApi()}/api${path}`, {
      method,
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-teamlink-token': syncToken() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) {
      if (!res.ok) throw new Error(`job portal answered ${res.status}`);
      return { buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const msg = (data && data.error && (data.error.message || data.error)) || text.slice(0, 200);
      throw new Error(`job portal answered ${res.status}: ${msg}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('the job portal did not answer in time');
    if (err.cause && err.cause.code === 'ECONNREFUSED') throw new Error('the job portal is not running (it starts with this server — see job-portal-app/run/portal.log)');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// One requirement, now. Called after publish/unpublish and after any change
// to a requirement that has ever been published. Never throws.
async function pushRequirement(requirementId) {
  try {
    const r = await prisma.requirement.findUnique({ where: { id: requirementId } });
    if (!r) return { ok: false, skipped: 'no such requirement' };
    // Never published: the portal has never heard of it and has nothing to close.
    if (!r.portalPublished && !r.portalPublishedAt) return { ok: true, skipped: 'never published' };
    const payload = jobPayload(r);
    await portalFetch(`/integrations/teamlink/jobs/${encodeURIComponent(r.id)}`, { method: 'PUT', body: payload });
    if (r.portalPublished) {
      // Closed there because "Job Portal" is unticked on the job: not a failure.
      const to = payload.status === 'open' ? 'Synced' : (portalTicked(r) ? 'Failed' : 'Not Synced');
      if (r.portalSyncStatus !== to) {
        await prisma.requirement.update({ where: { id: r.id }, data: { portalSyncStatus: to } });
      }
    }
    return { ok: true, status: payload.status, url: jobUrl(r.id) };
  } catch (err) {
    if (!err.notConfigured) console.error(`[job-portal] requirement ${requirementId} not pushed: ${err.message}`);
    await prisma.requirement.updateMany({
      where: { id: requirementId, portalPublished: true },
      data: { portalSyncStatus: 'Failed' },
    }).catch(() => {});
    await prisma.syncLog.create({
      data: { entity: 'Requirements', status: 'Failed', reason: `Job Portal push failed: ${err.message}`, recordRef: requirementId },
    }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

// Is this job live on the portal right now? Asked of the portal itself (its
// public job endpoint, GET /api/jobs/:id — what its own job page reads).
// Never throws: { live, reason }.
async function portalJobLive(requirementId) {
  if (require('./sandbox').isSandbox()) return { live: false, reason: 'the TEST SANDBOX never contacts the job portal' }; // eslint-disable-line global-require
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`${portalApi()}/api/jobs/${encodeURIComponent(portalJobId(requirementId))}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => null);
    const job = data && data.job;
    if (res.status === 200 && job && (job.status === 'open' || job.status === undefined)) return { live: true, via: `GET /jobs/api/jobs/${portalJobId(requirementId)} → 200` };
    return { live: false, via: `GET /jobs/api/jobs/${portalJobId(requirementId)} → ${res.status}${job ? ` (${job.status})` : ''}` };
  } catch (err) {
    return { live: false, unreachable: true, reason: err.name === 'AbortError' ? 'the job portal did not answer in time' : 'the job portal is not running' };
  } finally {
    clearTimeout(timer);
  }
}

// ---- portal -> ATS --------------------------------------------------------

// The portal records a board as a lower-case name (naukri, linkedin …); the
// ATS reports on the names its own tagged links use (routes/public.js).
const BOARD_NAMES = {
  naukri: 'Naukri', indeed: 'Indeed', shine: 'Shine', linkedin: 'LinkedIn',
  facebook: 'Facebook', whatsapp: 'WhatsApp', x: 'X',
};

// An existing candidate with this email or phone, by the Candidate Master's
// normalised keys — the oldest record wins, as it does in a merge. Used for
// portal imports here and for the public careers form (routes/public.js), so
// neither can create a second record for somebody already on file.
async function findCandidateByContact({ email, phone }) {
  const ek = emailKey(email);
  if (ek) {
    const rows = await prisma.candidate.findMany({ where: { email: { contains: ek } }, orderBy: { createdAt: 'asc' }, take: 25 });
    const hit = rows.find((r) => emailKey(r.email) === ek);
    if (hit) return hit;
  }
  for (const k of phoneKeys(phone)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.candidate.findMany({ where: { phone: { contains: k } }, orderBy: { createdAt: 'asc' }, take: 25 });
    const hit = rows.find((r) => phoneKeys(r.phone).includes(k));
    if (hit) return hit;
  }
  return null;
}

async function findCandidate({ email, phone, ref }) {
  if (ref) {
    const byRef = await prisma.candidate.findFirst({ where: { externalRef: ref } });
    if (byRef) return byRef;
  }
  return findCandidateByContact({ email, phone });
}

// Serialised: the portal's push and this server's pull can carry the same
// application at the same moment, and two parallel "not found → create" runs
// would make two candidates. One at a time, in this process, removes the race.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function ingestApplication(payload) {
  return serial(() => ingestOne(payload));
}

// The resume the application was made with, fetched from the portal and kept
// as an ORIGINAL version (Resume tab, Fit %, extraction — utils/resumeStore.js).
// Never throws: a resume that cannot be fetched never loses the application.
async function attachResume(app, candidate, requirement) {
  if (!app.resume || !app.resume.path) return { saved: false, reason: 'no resume on the portal application' };
  try {
    const rel = String(app.resume.path).replace(/^\/api/, '');
    const { buffer, headers } = await portalFetch(rel, { raw: true, timeoutMs: 30000 });
    const fromHeader = headers.get('x-file-name');
    const filename = (fromHeader ? decodeURIComponent(fromHeader) : null) || app.resume.fileName || 'resume.pdf';
    // eslint-disable-next-line global-require
    await require('./resumeStore').saveOriginalResume({
      candidateId: candidate.id,
      file: { data: buffer, filename },
      note: `Job Portal application · ${requirement.title}`,
    });
    return { saved: true };
  } catch (err) {
    console.error(`[job-portal] resume not stored for portal application ${app.id}: ${err.code || err.message}`);
    return { saved: false, reason: err.code || err.message };
  }
}

async function ingestOne(payload) {
  const p = payload || {};
  const app = p.application || {};
  const c = p.candidate || {};
  const requirementId = p.requirementId || requirementIdOf(app.jobId);
  if (!app.id || !requirementId) return { status: 400, body: { error: 'application.id and requirementId are required' } };
  const name = String(c.name || '').trim();
  if (!name || (!c.email && !c.phone && !c.id)) return { status: 400, body: { error: 'candidate name and email or phone are required' } };

  const requirement = await prisma.requirement.findUnique({ where: { id: requirementId } });
  if (!requirement) {
    await prisma.syncLog.create({
      data: { entity: 'Applications', status: 'Failed', reason: `Job Portal application ${app.id}: requirement ${requirementId} does not exist`, recordRef: app.id },
    });
    return { status: 404, body: { error: 'Requirement not found' } };
  }

  const email = c.email ? String(c.email).trim() : null;
  const phone = c.phone ? String(c.phone).trim() : null;
  // A stable key only for somebody with neither email nor phone — the same
  // rule the data import applies to Candidate.externalRef.
  const ref = !email && !phone && c.id ? `jobportal:${c.id}` : null;
  const board = BOARD_NAMES[String(app.source || '').toLowerCase()] || null;

  let candidate = await findCandidate({ email, phone, ref });
  let createdCandidate = false;
  if (!candidate) {
    const skills = Array.isArray(c.skills) ? c.skills.filter(Boolean).join(', ') : (c.skills || null);
    candidate = await prisma.candidate.create({
      data: {
        name,
        email,
        phone,
        source: 'Job Portal',
        firstSource: board || PORTAL_APPLICATION_SOURCE,
        externalRef: ref,
        location: c.location || null,
        currentCompany: c.currentCompany || null,
        currentDesignation: c.title || null,
        experienceYears: Number.isFinite(Number(c.expYears)) && c.expYears !== null ? Number(c.expYears) : null,
        skills: skills || null,
        education: c.education || null,
        noticePeriod: c.noticePeriod || undefined,
        expectedSalary: c.expectedCtc != null ? String(c.expectedCtc) : null,
        resumeName: c.resumeFile || null,
      },
    });
    createdCandidate = true;
    await prisma.syncLog.create({
      data: { entity: 'Candidates', status: 'Success', reason: `${candidate.name} registered from the TeamLink Job Portal`, recordRef: candidate.id },
    });
  }

  const existing = await prisma.application.findUnique({
    where: { candidateId_requirementId: { candidateId: candidate.id, requirementId } },
  });
  if (existing) {
    return { status: 200, body: { ok: true, duplicate: true, applicationId: existing.id, candidateId: candidate.id, stage: existing.stage } };
  }

  const score = Number(app.matchScore);
  const application = await prisma.application.create({
    data: {
      candidateId: candidate.id,
      requirementId,
      stage: 'NEW',
      source: PORTAL_APPLICATION_SOURCE,
      firstSource: board || PORTAL_APPLICATION_SOURCE,
      applicationMethod: 'Auto-Apply',
      matchScore: Number.isFinite(score) && app.matchScore !== null ? Math.round(score) : null,
    },
  });
  const resume = await attachResume(app, candidate, requirement);
  // b5_/b6_ (ATS-100): the portal's own consent answers, and where the person
  // came from — utm_* + ?ref=<code> remembered by the embed host (p.attribution),
  // or a referral code the portal recorded as the source (it reads ?ref= too).
  try {
    // eslint-disable-next-line global-require
    const CR = require('./candidateRecord');
    if (CR.supported()) {
      const consent = CR.consentFromPortal(p.consent);
      if (consent) {
        await CR.setConsent(candidate.id, { ...consent, source: 'portal', byName: candidate.name });
      }
      const attr = p.attribution && typeof p.attribution === 'object' ? p.attribution : {};
      const refCode = attr.ref || (CR.normCode(app.source) ? app.source : null);
      await CR.attach({ application, candidate, utm: attr, refCode, via: 'LINK' });
    }
  } catch (err) {
    console.error(`[job-portal] consent / source not stored for ${application.id}: ${err.message}`);
  }
  try { require('./candidateListCache').markCandidateDirty(candidate.id); } catch { /* optional */ } // eslint-disable-line global-require
  await prisma.syncLog.create({
    data: {
      entity: 'Applications', status: 'Success',
      reason: `${candidate.name} → ${requirement.title} (portal ${app.reference || app.id})${resume.saved ? ' + resume' : ''}`,
      recordRef: application.id,
    },
  });
  await logAudit({
    action: 'Job Portal application received', entity: 'Application', entityId: application.id,
    toValue: `${candidate.name} · portal ${app.reference || app.id}`,
  });
  try {
    // eslint-disable-next-line global-require
    await require('./notify').notifyUsers([requirement.recruiterId, requirement.tlId].filter(Boolean), {
      title: 'New application from the job portal',
      message: `${candidate.name} → ${requirement.title}`,
    });
  } catch { /* the application is in; a bell that did not ring is not a failure */ }
  return {
    status: 201,
    body: {
      ok: true, applicationId: application.id, candidateId: candidate.id, createdCandidate, stage: application.stage, resumeSaved: resume.saved,
    },
  };
}

// ATS stage -> the portal's pipeline stage (job-portal-app stages table). The
// portal has fewer, applicant-facing stages; each ATS stage lands on the one
// that describes it to the applicant.
// NEW and Recruiter Review are not sent: the portal already shows 'Applied'
// (or its own AI screening), and saying 'Applied' again would only move it back.
const PORTAL_STAGE_OF = {
  AI_INTERVIEW_REQUIRED: 'ai_screening',
  AI_INTERVIEW_SCHEDULED: 'ai_screening',
  AI_INTERVIEW_COMPLETED: 'ai_interview_done',
  RECRUITER_APPROVED: 'shortlisted',
  TL_REVIEW: 'shortlisted',
  WITH_BDE: 'with_bde',
  BDE_APPROVED: 'with_bde',
  SHARED_WITH_CLIENT: 'client_review',
  CLIENT_REVIEW: 'client_review',
  CLIENT_SHORTLISTED: 'client_review',
  INTERVIEW_SCHEDULED: 'interview_scheduled',
  INTERVIEW_COMPLETED: 'interview_scheduled',
  SELECTED: 'selected',
  OFFER: 'offer_extended',
  OFFER_ACCEPTED: 'offer_extended',
  JOINED: 'joined',
  HIRED: 'joined',
  REJECTED: 'rejected',
  HOLD: 'hold',
};

// ---- the whole picture ----------------------------------------------------

let lastRun = null;

// Every published, live requirement is upserted as an open job; every other
// TeamLink job on the portal is closed (closeOthers). Then applications made
// on the portal in the last `pullDays` days are pulled and ingested — the
// catch-up for anything the portal's push could not deliver.
async function fullSync({ requirementIds = null, pullDays = 90, actor = 'system' } = {}) {
  const started = new Date();
  const out = { ok: true, jobs: 0, closed: 0, pruned: 0, failed: 0, pulled: 0, created: 0, stageUpdates: 0, errors: [], error: null };
  try {
    const where = { portalPublished: true, status: { in: REQUIREMENT_LIVE_STATUSES } };
    // Unticked "Job Portal" on the job = not offered there (closeOthers closes it).
    const live = (await prisma.requirement.findMany({ where })).filter(portalTicked);
    // Every requirement ever published: a portal job outside this list belongs
    // to a requirement deleted here, and the portal removes it if nobody applied.
    const known = await prisma.requirement.findMany({
      where: { OR: [{ portalPublished: true }, { portalPublishedAt: { not: null } }] }, select: { id: true },
    });
    const res = await portalFetch('/integrations/teamlink/jobs/sync', {
      method: 'POST',
      timeoutMs: 30000,
      body: { jobs: live.map(jobPayload), closeOthers: true, pruneMissing: true, knownIds: known.map((k) => k.id) },
    });
    out.pruned = ((res && res.pruned) || []).length;
    const results = (res && res.results) || [];
    const okIds = results.filter((x) => !x.error).map((x) => x.requirementId);
    const badIds = results.filter((x) => x.error).map((x) => x.requirementId);
    out.jobs = okIds.length;
    out.failed = badIds.length;
    out.closed = ((res && res.closed) || []).length;
    const scope = (ids) => (requirementIds ? ids.filter((id) => requirementIds.includes(id)) : ids);
    if (okIds.length) await prisma.requirement.updateMany({ where: { id: { in: scope(okIds) } }, data: { portalSyncStatus: 'Synced' } });
    if (badIds.length) await prisma.requirement.updateMany({ where: { id: { in: scope(badIds) } }, data: { portalSyncStatus: 'Failed' } });
    // Published but no longer live: it cannot be on offer, so it is not "Synced".
    await prisma.requirement.updateMany({
      where: { portalPublished: true, status: { notIn: REQUIREMENT_LIVE_STATUSES }, ...(requirementIds ? { id: { in: requirementIds } } : {}) },
      data: { portalSyncStatus: 'Failed' },
    });

    const since = new Date(Date.now() - pullDays * 86400000).toISOString();
    const pulled = await portalFetch(`/integrations/teamlink/applications?since=${encodeURIComponent(since)}&limit=2000`, { timeoutMs: 30000 });
    const apps = (pulled && pulled.applications) || [];
    out.pulled = apps.length;
    const stageUpdates = [];
    for (const a of apps) {
      // eslint-disable-next-line no-await-in-loop
      const r = await ingestApplication(a).catch((e) => ({ status: 500, body: { error: e.message } }));
      if (r.status === 201) out.created += 1;
      if (r.status >= 400) {
        out.errors.push(`portal application ${(a.application && (a.application.reference || a.application.id)) || '?'}: ${r.body && r.body.error}`);
        continue;
      }
      // STATUS BACK TO THE PORTAL: the applicant sees on the portal where
      // their application stands in the ATS.
      const atsStage = r.body && r.body.stage;
      const want = PORTAL_STAGE_OF[atsStage];
      if (want && a.application && want !== a.application.stage) {
        stageUpdates.push({ id: a.application.id, stage: want, note: `TeamLink ATS: ${atsStage}` });
      }
    }
    if (stageUpdates.length) {
      try {
        const res2 = await portalFetch('/integrations/teamlink/applications/stages', {
          method: 'POST', timeoutMs: 30000, body: { updates: stageUpdates },
        });
        const results2 = (res2 && res2.results) || [];
        out.stageUpdates = results2.filter((x) => x.changed).length;
        results2.filter((x) => x.error).forEach((x) => out.errors.push(`status to portal for ${x.id}: ${x.error}`));
      } catch (err) {
        out.errors.push(`status updates not sent to the portal: ${err.message}`);
      }
    }
  } catch (err) {
    out.ok = false;
    out.error = err.message;
  }
  lastRun = { at: started, actor, ...out };
  // An AUTOMATIC run (startup / hourly) that fails exactly like the previous
  // run is not logged again, so a portal that is switched off does not add an
  // identical "not reachable" row on every restart. A manual Sync / Retry is
  // always logged.
  const logStatus = out.ok && !out.failed && !out.errors.length ? 'Success' : 'Failed';
  const counts = `${out.jobs} job(s) live, ${out.closed} closed, ${out.pruned} removed (requirement deleted), ${out.failed} failed; `
    + `${out.pulled} portal application(s) checked, ${out.created} new in the ATS, ${out.stageUpdates} status update(s) sent back.`;
  const reason = out.ok
    ? `Job Portal sync (${actor}): ${counts}${out.errors.length ? ` ${out.errors.length} problem(s): ${out.errors.slice(0, 3).join('; ')}` : ''}`
    : `Job Portal sync (${actor}) failed: ${out.error}`;
  if (actor === 'startup' || actor === 'hourly') {
    const prev = await prisma.syncLog.findFirst({
      where: { entity: 'Requirements', reason: { startsWith: 'Job Portal sync' } },
      orderBy: { createdAt: 'desc' }, select: { status: true, reason: true },
    }).catch(() => null);
    if (prev && prev.status === 'Failed' && !out.ok && String(prev.reason || '').endsWith(` failed: ${out.error}`)) return out;
    // Every nodemon restart runs a startup sync; one that changed nothing and
    // reads like the last automatic row is not logged again.
    const nothingMoved = out.ok && !out.closed && !out.pruned && !out.failed && !out.created && !out.stageUpdates && !out.errors.length;
    if (nothingMoved && prev && prev.status === 'Success' && /^Job Portal sync \((startup|hourly)\): /.test(prev.reason || '')
      && String(prev.reason).replace(/^Job Portal sync \((startup|hourly)\): /, '') === counts) return out;
  }
  await prisma.syncLog.create({ data: { entity: 'Requirements', status: logStatus, reason } }).catch(() => {});
  return out;
}

let timer = null;
function startSchedule() {
  if (timer || !syncToken()) {
    if (!syncToken()) console.log('[job-portal] JOB_PORTAL_SYNC_TOKEN not set — portal sync is off.');
    return;
  }
  const every = process.env.JOB_PORTAL_SYNC_INTERVAL_MS === undefined
    ? 3600000 : Number(process.env.JOB_PORTAL_SYNC_INTERVAL_MS);
  const run = (actor) => fullSync({ actor }).then((r) => {
    if (!r.ok) console.warn(`[job-portal] ${actor} sync: ${r.error}`);
  }).catch(() => {});
  // After boot, so the embedded portal (started alongside) has a moment.
  setTimeout(() => run('startup'), 30000).unref();
  if (every > 0) timer = setInterval(() => run('hourly'), every);
  if (timer) timer.unref();
}

function status() {
  return {
    url: portalUrl(),
    configured: !!(syncToken() && pushSecret()),
    embedded: embed().enabled(),
    lastRun,
  };
}

// A real reachability check for Integrations → Test: is the portal answering,
// do the sync secrets work? Never throws.
async function ping() {
  if (require('./sandbox').isSandbox()) return { ok: false, result: 'Sandbox — the job portal is never contacted from the test sandbox' }; // eslint-disable-line global-require
  if (!(syncToken() && pushSecret())) return { ok: false, result: 'JOB_PORTAL_SYNC_TOKEN / JOB_PORTAL_PUSH_SECRET are not set in backend/.env' };
  try {
    await portalFetch('/integrations/teamlink/ping', { timeoutMs: 8000 });
    return { ok: true, result: `Connected — the job portal is running and answering at ${portalUrl()}/` };
  } catch (err) {
    return { ok: false, result: `Failed — ${err.message}` };
  }
}

module.exports = {
  portalUrl, portalJobId, jobUrl, secretMatches, pushRequirement, ingestApplication, fullSync,
  startSchedule, status, ping, findCandidateByContact, PORTAL_STAGE_OF, portalJobLive, portalApi,
};
