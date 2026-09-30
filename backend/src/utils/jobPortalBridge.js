// ---------------------------------------------------------------------------
// The TeamLink Job Portal bridge — the real two-way sync.
//
// The Job Portal is its own application (job-portal-app/, Express +
// PostgreSQL, port 4323 in development). It replaced the single-file
// localStorage portal that used to be served at /job-portal/. This module is
// the whole of TeamLink's side of the connection:
//
//   ATS -> portal   a requirement that is PUBLISHED and LIVE is a job on the
//                   portal, keyed tl_<requirement id>; anything else that was
//                   once published is closed there. Pushed on publish /
//                   unpublish and on every requirement change, on "Sync now",
//                   at startup and hourly (fullSync).
//   portal -> ATS   an application made on the portal becomes a Candidate
//                   (deduplicated by email, then phone) and an Application at
//                   NEW, source "TeamLink Job Portal" — pushed by the portal
//                   the moment it is made (POST /api/public/job-portal/
//                   applications, routes/jobPortalBridge.js), and pulled back
//                   by fullSync as a catch-up. Idempotent: one portal
//                   application is one pipeline row however often it arrives.
//
// Environment (backend/.env — names only, never values in logs):
//   JOB_PORTAL_URL               what a browser opens (default http://localhost:4323)
//   JOB_PORTAL_API_URL           what this server calls (default JOB_PORTAL_URL)
//   JOB_PORTAL_SYNC_TOKEN        sent to the portal as x-teamlink-token
//   JOB_PORTAL_PUSH_SECRET       expected from the portal as x-job-portal-secret
//   JOB_PORTAL_SYNC_INTERVAL_MS  hourly by default; 0 switches the timer off
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
const portalUrl = () => trimSlash(process.env.JOB_PORTAL_URL || 'http://localhost:4323');
const portalApi = () => trimSlash(process.env.JOB_PORTAL_API_URL || portalUrl());
const syncToken = () => process.env.JOB_PORTAL_SYNC_TOKEN || '';
const pushSecret = () => process.env.JOB_PORTAL_PUSH_SECRET || '';

const portalJobId = (requirementId) => `tl_${requirementId}`;
const requirementIdOf = (jobId) => (String(jobId || '').startsWith('tl_') ? String(jobId).slice(3) : null);
// The portal routes on the hash; ?src= is read by the portal and recorded as
// the application's source, which comes back here as firstSource.
function jobUrl(requirementId, src) {
  return `${portalUrl()}/${src ? `?src=${encodeURIComponent(src)}` : ''}#/job/${portalJobId(requirementId)}`;
}

function secretMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(pushSecret());
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- ATS -> portal --------------------------------------------------------

const lines = (v) => String(v || '').split(/\r?\n/).map((s) => s.replace(/^[\s•*-]+/, '').trim()).filter(Boolean);
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function jobPayload(r) {
  const open = !!r.portalPublished && requirementIsLive(r.status);
  const exp = r.experience ? (/yr|year/i.test(r.experience) ? r.experience : `${r.experience} yrs`) : null;
  return {
    requirementId: r.id,
    reqCode: r.reqCode || null,
    title: r.title,
    location: r.location || null,
    mode: r.workMode || null,
    exp,
    pay: r.salary && r.salary !== '—' ? r.salary : null,
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

async function portalFetch(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  if (!syncToken()) {
    const err = new Error('JOB_PORTAL_SYNC_TOKEN is not set in backend/.env');
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
    if (err.cause && err.cause.code === 'ECONNREFUSED') throw new Error(`the job portal is not reachable at ${portalApi()}`);
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
      const to = payload.status === 'open' ? 'Synced' : 'Failed';
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
  await prisma.syncLog.create({
    data: {
      entity: 'Applications', status: 'Success',
      reason: `${candidate.name} → ${requirement.title} (portal ${app.reference || app.id})`,
      recordRef: application.id,
    },
  });
  await logAudit({
    action: 'Job Portal application received', entity: 'Application', entityId: application.id,
    toValue: `${candidate.name} · portal ${app.reference || app.id}`,
  });
  return {
    status: 201,
    body: { ok: true, applicationId: application.id, candidateId: candidate.id, createdCandidate, stage: application.stage },
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
    const live = await prisma.requirement.findMany({ where });
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
        // An older portal without the stages route: jobs and applications
        // still synced, so this is reported, not fatal.
        out.errors.push(`status updates not sent to the portal: ${err.message}`);
      }
    }
  } catch (err) {
    out.ok = false;
    out.error = err.message;
  }
  lastRun = { at: started, actor, ...out };
  await prisma.syncLog.create({
    data: {
      entity: 'Requirements',
      status: out.ok && !out.failed && !out.errors.length ? 'Success' : 'Failed',
      reason: out.ok
        ? `Job Portal sync (${actor}): ${out.jobs} job(s) live, ${out.closed} closed, ${out.pruned} removed (requirement deleted), ${out.failed} failed; `
          + `${out.pulled} portal application(s) checked, ${out.created} new in the ATS, ${out.stageUpdates} status update(s) sent back.`
          + (out.errors.length ? ` ${out.errors.length} problem(s): ${out.errors.slice(0, 3).join('; ')}` : '')
        : `Job Portal sync (${actor}) failed: ${out.error}`,
    },
  }).catch(() => {});
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
  // Shortly after boot, so the portal (often started alongside) has a moment.
  setTimeout(() => run('startup'), 15000).unref();
  if (every > 0) timer = setInterval(() => run('hourly'), every);
  if (timer) timer.unref();
}

function status() {
  return {
    url: portalUrl(),
    configured: !!(syncToken() && pushSecret()),
    lastRun,
  };
}

// A real reachability check for Integrations → Test: is the portal app
// answering, and are both sync secrets set? Never throws.
async function ping() {
  const configured = !!(syncToken() && pushSecret());
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`${portalApi()}/`, { signal: ctl.signal });
    if (res.status >= 500) return { ok: false, result: `Failed — the job portal answered ${res.status} at ${portalApi()}` };
    if (!configured) return { ok: false, result: `Reachable at ${portalApi()}, but JOB_PORTAL_SYNC_TOKEN / push secret are not set in backend/.env` };
    return { ok: true, result: `Connected — job portal answering at ${portalApi()}` };
  } catch (err) {
    return { ok: false, result: err.name === 'AbortError' ? `Failed — the job portal did not answer in time (${portalApi()})` : `Failed — the job portal is not reachable at ${portalApi()}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  portalUrl, portalJobId, jobUrl, secretMatches, pushRequirement, ingestApplication, fullSync,
  startSchedule, status, ping, findCandidateByContact, PORTAL_STAGE_OF,
};
