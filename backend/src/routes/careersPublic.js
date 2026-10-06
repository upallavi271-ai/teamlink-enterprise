// ---------------------------------------------------------------------------
// /api/public/careers — THE TEAMLINK JOB PORTAL, BUILT IN (2026-10-05).
//
// The job portal used to be a separate application (job-portal-app/, port
// 4323, its own PostgreSQL) kept in step by a sync (utils/jobPortalBridge.js).
// It now lives here: the public pages at /careers read and write THIS
// database directly, so a job published in the ATS is on /careers the moment
// it is published, and an application made on /careers is in Candidates ->
// "New from job portal" the moment it is sent. No sync, no second server.
//
//   GET  /jobs                  the open jobs + cascading filter options
//        ?q= &loc= &exp= &mode= &type= &dept= &posted= &sort=latest|relevant
//   GET  /jobs/:id              one job (or { closed: true } once it is off)
//   POST /jobs/:id/apply        multipart: name, email, phone, resume file,
//                               optional location / experienceYears /
//                               currentCompany / noticePeriod / expectedSalary
//                               / skills, consent=yes, src (?src= of the link),
//                               utm_source / utm_medium / utm_campaign /
//                               utm_content, ref (a referral code) — b6_
//
// WHICH JOBS: published to the job portal + live + "Job Portal" ticked on the
// job — exactly the rule the sync used to decide what was open on the portal
// (jobPortalBridge.jobPayload). The client is never named: the advertiser is
// TeamLink Consultants, as on every public channel.
//
// AN APPLICATION lands exactly as the sync landed one: the applicant is the
// existing candidate with that email / phone (candidateDedupe keys) or a new
// one (source "Job Portal"); the application is at NEW, source "TeamLink Job
// Portal", firstSource = the board from ?src= (or the portal), method
// "Auto-Apply". A second application to the same job is refused. The resume
// is stored as an ORIGINAL version (utils/resumeStore.js: PDF/DOC/DOCX, bytes
// checked, 10 MB).
//
// PUBLIC = UNTRUSTED: per-IP and per-email rate limits, strict validation, a
// hidden honeypot field, and nothing about any person is ever returned.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { ipOf } = require('../utils/candidatePortalAuth');
const { emailKey, phoneKeys } = require('../utils/candidateDedupe');
const store = require('../utils/resumeStore');
const {
  REQUIREMENT_LIVE_STATUSES, requirementIsLive, PORTAL_APPLICATION_SOURCE,
} = require('../utils/atsVocab');

const router = express.Router();
const PUBLIC_COMPANY = 'TeamLink Consultants';

// ---- rate limits (in memory, per process) ----------------------------------
const hits = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20000) { // never grows without bound
    for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] > 3600000) hits.delete(k); }
  }
  return true;
}
const MIN = 60 * 1000;
const LIMITS = {
  read: { n: 240, ms: MIN },          // list + detail, per IP
  apply: { n: 8, ms: 15 * MIN },      // applications, per IP
  applyEmail: { n: 5, ms: 60 * MIN }, // applications, per email address
};
function readLimit(req, res, next) {
  if (!allow(`read|${ipOf(req)}`, LIMITS.read.n, LIMITS.read.ms)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }
  return next();
}

// ---- which jobs are on the portal -------------------------------------------
// eslint-disable-next-line global-require
const portalTicked = (r) => require('../utils/jobPosting').siteTicked(r, 'jobportal');
const isListed = (r) => !!r && !!r.portalPublished && requirementIsLive(r.status) && portalTicked(r);

const lines = (v) => String(v || '').split(/\r?\n/).map((s) => s.replace(/^[\s•*-]+/, '').trim()).filter(Boolean);
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const clean = (v) => (v == null || String(v).trim() === '' || String(v).trim() === '—' ? null : String(v).trim());

function expLabel(v) {
  const e = clean(v);
  if (!e) return null;
  return /yr|year|fresher/i.test(e) ? e : `${e} yrs`;
}
// The experience band a job sits in, from its lowest number of years.
const EXP_BANDS = [
  { v: '0-1', label: 'Fresher (0–1 yrs)', lo: 0, hi: 1 },
  { v: '1-3', label: '1–3 yrs', lo: 1, hi: 3 },
  { v: '3-5', label: '3–5 yrs', lo: 3, hi: 5 },
  { v: '5-10', label: '5–10 yrs', lo: 5, hi: 10 },
  { v: '10+', label: '10+ yrs', lo: 10, hi: Infinity },
];
function expBand(v) {
  const e = String(v || '');
  if (/fresher/i.test(e)) return '0-1';
  const n = (e.match(/\d+(\.\d+)?/) || [])[0];
  if (n == null) return null;
  const lo = Number(n);
  const band = EXP_BANDS.find((b) => lo >= b.lo && lo < b.hi);
  return band ? band.v : null;
}
const POSTED = [
  { v: '1', label: 'Last 24 hours', days: 1 },
  { v: '3', label: 'Last 3 days', days: 3 },
  { v: '7', label: 'Last 7 days', days: 7 },
  { v: '30', label: 'Last 30 days', days: 30 },
];

function postedAt(r) { return r.portalPublishedAt || r.createdAt; }

// Readable job links /careers/<slug> (utils/jobSlug.js, Save & Post §21).
const { slugOf, findByIdOrSlug, careersPath } = require('../utils/jobSlug');
// B9.5: Cloudflare Turnstile on the apply form when Administration →
// Integrations → Bot protection is set up; nothing changes when it is not.
const BOT = require('../utils/botProtection');

function cardOf(r) {
  const desc = clean(r.jobDescription) || clean(r.description) || '';
  return {
    id: r.id,
    slug: slugOf(r),
    reference: r.reqCode || null,
    title: r.title,
    company: PUBLIC_COMPANY,
    location: clean(r.location),
    workMode: clean(r.workMode),
    employmentType: clean(r.employmentType),
    experience: expLabel(r.experience),
    salary: clean(r.salary),
    department: clean(r.department),
    openings: r.openings || 1,
    skills: csv(r.skills).slice(0, 12),
    snippet: desc.length > 180 ? `${desc.slice(0, 180).trim()}…` : desc,
    postedAt: postedAt(r),
  };
}

const LIST_SELECT = {
  id: true, reqCode: true, title: true, location: true, workMode: true, employmentType: true, experience: true,
  salary: true, department: true, openings: true, skills: true, jobDescription: true, description: true,
  portalPublished: true, portalPublishedAt: true, createdAt: true, status: true, postingSources: true,
};

async function listedJobs() {
  const rows = await prisma.requirement.findMany({
    where: { portalPublished: true, status: { in: REQUIREMENT_LIVE_STATUSES } },
    select: LIST_SELECT,
    orderBy: [{ portalPublishedAt: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.filter(isListed);
}

// One test per filter, so the options of each filter can be counted on the
// jobs that match all the OTHER filters (the cascading-filter rule).
function tests(f) {
  const q = String(f.q || '').toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);
  const now = Date.now();
  return {
    q: (r) => !words.length || words.every((w) => [r.title, r.skills, r.department, r.location, r.jobDescription, r.description]
      .some((x) => String(x || '').toLowerCase().includes(w))),
    loc: (r) => !f.loc || String(r.location || '').toLowerCase().includes(String(f.loc).toLowerCase()),
    exp: (r) => !f.exp || expBand(r.experience) === f.exp,
    mode: (r) => !f.mode || clean(r.workMode) === f.mode,
    type: (r) => !f.type || clean(r.employmentType) === f.type,
    dept: (r) => !f.dept || clean(r.department) === f.dept,
    posted: (r) => {
      const p = POSTED.find((x) => x.v === String(f.posted || ''));
      return !p || now - new Date(postedAt(r)).getTime() <= p.days * 86400000;
    },
  };
}
function passesAll(r, t, except) {
  return Object.keys(t).every((k) => k === except || t[k](r));
}
function facet(rows, t, key, valueOf, known) {
  const counts = new Map();
  rows.filter((r) => passesAll(r, t, key)).forEach((r) => {
    const vals = [].concat(valueOf(r)).filter(Boolean);
    vals.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  });
  if (known) {
    return known.filter((k) => counts.get(k.v)).map((k) => ({ value: k.v, label: k.label, count: counts.get(k.v) }));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([value, count]) => ({ value, label: value, count }));
}

const pick = (v, max = 80) => (v == null ? '' : String(v).trim().slice(0, max));

router.get('/jobs', readLimit, async (req, res) => {
  const f = {
    q: pick(req.query.q, 120), loc: pick(req.query.loc), exp: pick(req.query.exp, 10), mode: pick(req.query.mode),
    type: pick(req.query.type), dept: pick(req.query.dept), posted: pick(req.query.posted, 4),
  };
  const all = await listedJobs();
  const t = tests(f);
  let rows = all.filter((r) => passesAll(r, t));
  if (req.query.sort === 'relevant' && f.q) {
    const q = f.q.toLowerCase();
    const score = (r) => (String(r.title).toLowerCase().includes(q) ? 2 : 0) + (String(r.skills || '').toLowerCase().includes(q) ? 1 : 0);
    rows = rows.slice().sort((a, b) => score(b) - score(a));
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    total: rows.length,
    totalOpen: all.length,
    jobs: rows.map(cardOf),
    facets: {
      loc: facet(all, t, 'loc', (r) => clean(r.location)),
      exp: facet(all, t, 'exp', (r) => expBand(r.experience), EXP_BANDS),
      mode: facet(all, t, 'mode', (r) => clean(r.workMode)),
      type: facet(all, t, 'type', (r) => clean(r.employmentType)),
      dept: facet(all, t, 'dept', (r) => clean(r.department)),
      posted: POSTED.map((p) => ({
        value: p.v,
        label: p.label,
        count: all.filter((r) => passesAll(r, t, 'posted') && Date.now() - new Date(postedAt(r)).getTime() <= p.days * 86400000).length,
      })).filter((p) => p.count),
    },
  });
});

// ---------------------------------------------------------------------------
// B9.6 SITEMAP — /sitemap.xml: the careers home + every public job's readable
// link (utils/jobSlug.js careersPath, the same links the job boards get), and
// /robots.txt pointing at it. Cached for 10 minutes. The site's address is
// APP_BASE_URL (Administration → the job boards use the same), else the
// address the request came in on.
// ---------------------------------------------------------------------------
const SITEMAP_MS = 10 * 60 * 1000;
let sitemapCache = { at: 0, base: '', xml: '' };
const xmlEsc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function siteBase(req) {
  // eslint-disable-next-line global-require
  const fromEnv = require('../utils/jobBoards/http').publicUrl('');
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}
async function sitemapXml(req) {
  const base = siteBase(req);
  if (sitemapCache.xml && sitemapCache.base === base && Date.now() - sitemapCache.at < SITEMAP_MS) return sitemapCache.xml;
  const jobs = await listedJobs();
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const urls = [
    { loc: `${base}/careers`, lastmod: day(jobs[0] && postedAt(jobs[0])), changefreq: 'hourly', priority: '1.0' },
    ...jobs.map((j) => ({ loc: `${base}${careersPath(j)}`, lastmod: day(postedAt(j)), changefreq: 'daily', priority: '0.8' })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url>\n    <loc>${xmlEsc(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n')}\n</urlset>\n`;
  sitemapCache = { at: Date.now(), base, xml };
  return xml;
}
async function sitemapHandler(req, res, next) {
  try {
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(await sitemapXml(req));
  } catch (err) { next(err); }
}
function robotsHandler(req, res) {
  const base = siteBase(req);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  // Public: the careers pages. Everything signed-in is not for crawlers.
  res.send(`User-agent: *\nAllow: /careers\nAllow: /jobs\nDisallow: /api/\nDisallow: /admin\nDisallow: /login\nSitemap: ${base}/sitemap.xml\n`);
}
router.get('/sitemap.xml', sitemapHandler);
router.get('/robots.txt', robotsHandler);
router.sitemap = sitemapHandler;
router.robots = robotsHandler;
router.resetSitemap = () => { sitemapCache = { at: 0, base: '', xml: '' }; };

router.get('/jobs/:id', readLimit, async (req, res) => {
  // An id (old links) or a slug ending in the Job ID.
  const r = await findByIdOrSlug(pick(req.params.id, 160));
  if (!isListed(r)) {
    // Once offered here and now off (closed, unpublished): say so plainly
    // instead of "not found", like the portal's "This role is closed".
    if (r && (r.portalPublished || r.portalPublishedAt)) return res.json({ id: r.id, title: r.title, closed: true });
    return res.status(404).json({ error: 'This job is not on the portal.' });
  }
  // Same 6 public jobs-or-fewer per row: similar = same department or a shared skill.
  const others = (await listedJobs()).filter((x) => x.id !== r.id);
  const mySkills = new Set(csv(r.skills).map((s) => s.toLowerCase()));
  const similar = others
    .map((x) => ({ x, rank: (x.department && x.department === r.department ? 1 : 0) + csv(x.skills).filter((s) => mySkills.has(s.toLowerCase())).length * 2 }))
    .filter((s) => s.rank > 0).sort((a, b) => b.rank - a.rank).slice(0, 3)
    .map((s) => cardOf(s.x));
  res.set('Cache-Control', 'no-store');
  return res.json({
    ...cardOf(r),
    // B9.5: null = no widget (honeypot + rate limit only); else { provider, siteKey, field }.
    botProtection: await BOT.publicConfig(),
    description: clean(r.jobDescription) || clean(r.description),
    responsibilities: lines(r.responsibilities),
    requirements: lines(r.qualifications),
    goodToHave: csv(r.goodToHaveSkills),
    education: clean(r.education),
    noticePeriodMax: clean(r.noticePeriodMax),
    closingDate: clean(r.closingDate),
    closed: false,
    similar,
  });
});

// ---- apply -------------------------------------------------------------------
// The board an applicant came from (?src= on the tagged link). Only these.
const TRACKED_SOURCES = ['Naukri', 'Indeed', 'Shine', 'LinkedIn', 'Facebook', 'WhatsApp', 'X', 'TeamLink Website', 'Google Jobs'];
const EMAIL_OK = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
const NAME_OK = /^[\p{L}][\p{L}\p{M} .'-]{1,99}$/u;

function validate(fields) {
  const g = (k, max = 200) => String(fields[k] == null ? '' : fields[k]).replace(/\s+/g, ' ').trim().slice(0, max);
  const out = {
    name: g('name', 100),
    email: g('email', 120).toLowerCase(),
    phone: g('phone', 30),
    location: g('location', 120) || null,
    currentCompany: g('currentCompany', 120) || null,
    noticePeriod: g('noticePeriod', 40) || null,
    expectedSalary: g('expectedSalary', 40) || null,
    skills: g('skills', 400) || null,
    experienceYears: null,
  };
  if (!NAME_OK.test(out.name)) return { error: 'Please type your full name (letters only).' };
  if (!EMAIL_OK.test(out.email) || !emailKey(out.email)) return { error: 'Please type a correct email address, like name@gmail.com.' };
  const digits = out.phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13 || !phoneKeys(out.phone).length) return { error: 'Please type your 10-digit mobile number.' };
  const exp = g('experienceYears', 6);
  if (exp) {
    const n = Number(exp);
    if (!Number.isFinite(n) || n < 0 || n > 60) return { error: 'Experience must be a number of years between 0 and 60.' };
    out.experienceYears = Math.round(n * 10) / 10;
  }
  if (!/^(yes|true|on|1)$/i.test(g('consent', 5))) return { error: 'Please tick the box to agree that TeamLink may use your resume for this job.' };
  return { value: out };
}

// One application at a time in this process: two parallel "not found ->
// create" runs for the same person would otherwise make two candidates.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function findByContact(email, phone) {
  // eslint-disable-next-line global-require
  return require('../utils/jobPortalBridge').findCandidateByContact({ email, phone });
}

router.post('/jobs/:id/apply', async (req, res) => {
  const ip = ipOf(req);
  if (!allow(`apply|${ip}`, LIMITS.apply.n, LIMITS.apply.ms)) {
    return res.status(429).json({ error: 'Too many applications from this network. Please try again in 15 minutes.' });
  }
  let parsed;
  try {
    parsed = await store.parseResumeUpload(req);
  } catch (err) {
    const code = err && err.code;
    if (code === 'NOT_MULTIPART') return res.status(400).json({ error: 'Please attach your resume and send the form again.' });
    return res.status(code === 'TOO_LARGE' ? 413 : 400).json({ error: store.RESUME_MESSAGE[code] || 'The form could not be read. Please try again.' });
  }
  const fields = parsed.fields || {};
  // Honeypot: a field people never see. A bot that fills it is answered like
  // a person and nothing is written.
  if (String(fields.website || '').trim()) return res.status(201).json({ ok: true, message: 'Application sent.' });
  // B9.5: the "I am human" check — only when Bot protection is configured.
  const bot = await BOT.verify(fields[BOT.TOKEN_FIELD], ip);
  if (!bot.ok) return res.status(400).json({ error: bot.error, code: 'BOT_CHECK' });

  const v = validate(fields);
  if (v.error) return res.status(400).json({ error: v.error });
  const data = v.value;
  if (!parsed.file) return res.status(400).json({ error: 'Please attach your resume (PDF or Word file).' });
  try {
    store.validateResumeFile(parsed.file);
  } catch (err) {
    return res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: store.RESUME_MESSAGE[err.code] || 'Only PDF and Word resumes can be sent.' });
  }
  if (!allow(`apply-email|${emailKey(data.email)}`, LIMITS.applyEmail.n, LIMITS.applyEmail.ms)) {
    return res.status(429).json({ error: 'Too many applications with this email in the last hour. Please try again later.' });
  }

  const job = await findByIdOrSlug(pick(req.params.id, 160));
  if (!isListed(job)) return res.status(404).json({ error: 'This job is not open any more.' });
  // A paused / archived client takes no new applications (spec 2026-10-03 §A).
  // eslint-disable-next-line global-require
  if (!job.internal && await require('../utils/clientLifecycle').newWorkRefusalFor(job.clientId)) {
    return res.status(409).json({ error: 'This job is not taking applications right now.' });
  }
  const src = String(fields.src || '');
  const board = TRACKED_SOURCES.includes(src) ? src : null;

  const out = await serial(async () => {
    let candidate = await findByContact(data.email, data.phone);
    let createdCandidate = false;
    if (!candidate) {
      candidate = await prisma.candidate.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone,
          source: 'Job Portal',
          firstSource: board || PORTAL_APPLICATION_SOURCE,
          location: data.location,
          currentCompany: data.currentCompany,
          experienceYears: data.experienceYears,
          skills: data.skills,
          noticePeriod: data.noticePeriod || undefined,
          expectedSalary: data.expectedSalary,
        },
      });
      createdCandidate = true;
      await prisma.syncLog.create({
        data: { entity: 'Candidates', status: 'Success', reason: `${candidate.name} registered on the TeamLink Job Portal (built in)`, recordRef: candidate.id },
      });
    } else {
      // An existing record keeps every value it has. Only an EMPTY email /
      // phone is filled, so this person can sign in with a code later.
      const fill = {};
      if (!candidate.email) fill.email = data.email;
      if (!candidate.phone) fill.phone = data.phone;
      if (Object.keys(fill).length) {
        candidate = await prisma.candidate.update({ where: { id: candidate.id }, data: fill });
        try { require('../utils/candidateListCache').markCandidateDirty(candidate.id); } catch { /* optional */ } // eslint-disable-line global-require
      }
    }

    const existing = await prisma.application.findUnique({
      where: { candidateId_requirementId: { candidateId: candidate.id, requirementId: job.id } },
    });
    if (existing) {
      await prisma.syncLog.create({
        data: { entity: 'Applications', status: 'Failed', reason: 'Duplicate application — this candidate already applied to this job (Job Portal, built in)', recordRef: existing.id },
      });
      return { duplicate: true };
    }
    const application = await prisma.application.create({
      data: {
        candidateId: candidate.id,
        requirementId: job.id,
        stage: 'NEW',
        source: PORTAL_APPLICATION_SOURCE,
        firstSource: board || PORTAL_APPLICATION_SOURCE,
        applicationMethod: 'Auto-Apply',
      },
    });
    return { candidate, createdCandidate, application };
  });

  if (out.duplicate) {
    return res.status(409).json({ error: 'You have already applied to this job. You can see it under "My applications".', duplicate: true });
  }
  const { candidate, application } = out;
  // The resume, as an ORIGINAL version (Resume tab, Fit %, extraction).
  let resumeSaved = false;
  try {
    await store.saveOriginalResume({ candidateId: candidate.id, file: parsed.file, note: `Job Portal application · ${job.title}` });
    resumeSaved = true;
  } catch (err) {
    console.error(`[careers] resume not stored for application ${application.id}: ${err.message}`);
  }
  // b5_/b6_ (ATS-100): the tick on this form IS the consent (form version +
  // IP kept as proof), and the link's utm_* / ?ref=<code> are stored on the
  // application. Never fails the application.
  try {
    // eslint-disable-next-line global-require
    const CR = require('../utils/candidateRecord');
    if (CR.supported()) {
      await CR.setConsent(candidate.id, {
        status: 'GIVEN', purposes: ['Recruitment'], source: 'careers', proof: `${CR.CAREERS_FORM_VERSION} · IP ${ip}`, byName: candidate.name,
      });
      await CR.attach({ application, candidate, utm: fields, refCode: fields.ref, via: 'LINK' });
    }
  } catch (err) {
    console.error(`[careers] consent / source not stored for application ${application.id}: ${err.message}`);
  }
  await prisma.syncLog.create({
    data: { entity: 'Applications', status: 'Success', reason: `${candidate.name} → ${job.title} (Job Portal, built in)`, recordRef: application.id },
  });
  await logAudit({
    action: 'Job Portal application received', entity: 'Application', entityId: application.id,
    toValue: `${candidate.name} · ${job.title}${board ? ` · via ${board}` : ''}`,
  });
  await notifyUsers([job.recruiterId, job.tlId], {
    title: 'New application from the job portal',
    message: `${candidate.name} → ${job.title}`,
  }).catch(() => null);
  return res.status(201).json({
    ok: true,
    message: 'Application sent. Our team will call you if your profile fits.',
    applicationId: application.id,
    resumeSaved,
  });
});

// TEST SANDBOX ONLY: clear the in-memory limits (test scripts run many cases
// from one address). Answers 404 everywhere else.
router.post('/_test/reset-limits', (req, res) => {
  // eslint-disable-next-line global-require
  if (!require('../utils/sandbox').isSandbox()) return res.status(404).json({ error: 'Not found' });
  hits.clear();
  return res.json({ ok: true });
});

module.exports = router;
// "Is this requirement on /careers right now?" — published + live + "Job Portal"
// ticked. Shared with the Save & Post screen (one rule, read from the DB row).
module.exports.isListed = isListed;
