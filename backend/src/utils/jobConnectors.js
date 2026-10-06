// ---------------------------------------------------------------------------
// SAVE & POST — ONE JOB, EVERY TICKED SOURCE (user, 2026-10-05).
//
// "The Posting Sources checkboxes are not display-only." When a job is saved
// with Save & Post, the ONE requirement (the master job id = Requirement.id)
// is published on every ticked source by that source's connector, at once,
// in the background. The recruiter never copies the job to another website.
// The result is stored PER SOURCE (RequirementPosting: status, externalJobId,
// externalUrl, postedAt, errorMessage, attempts = retryCount, lastTriedAt) and
// the job page shows it live, with Retry on the failed ones.
//
// THE SOURCES AND HOW EACH ONE REALLY POSTS (research 2026-10-05, doc links in
// each module):
//   TeamLink Job Portal  the customer's portal, embedded at /jobs — sent by
//                        jobPortalBridge; Posted when the PORTAL answers that
//                        the job is live (its public GET /jobs/api/jobs/tl_<id>)
//   Website              our website job list — Posted when the job is in
//                        /api/public/jobs.feed (fetched back)
//   Google Jobs          utils/jobBoards/google.js — JobPosting data checked
//                        at /api/public/jobs/:id/jsonld = "Submitted to feed";
//                        with a service account: Indexing API notification and
//                        "Posted" only when URL Inspection confirms it
//   Indeed               utils/jobBoards/indeed.js — Job Sync API (partner)
//   LinkedIn             utils/jobBoards/linkedin.js — Job Posting API (partner,
//                        closed to new partners at the time of writing)
//   Naukri, Shine        utils/jobBoards/partner.js — no public API; partner
//                        integration (Naukri: Zwayam Amplify)
//
// RULES THIS FILE KEEPS
//   * "Posted" only after a real confirmation (our own public URL serves it,
//     or the board says the job is live). Sent-but-not-confirmed = Pending;
//     in a feed the board pulls = Submitted to feed.
//   * A board with no authorised account set up in Administration →
//     Integrations is "Integration Required" — nothing is sent, and the hint
//     names exactly what to get and from whom.
//   * One source failing never fails the job or the other sources.
//   * Never a second requirement, never a second posting: one row per (job,
//     source); boards are sent the master job id as their reference (Indeed
//     and the partner boards upsert on it, LinkedIn gets UPDATE); runs for one
//     job are serialised.
//   * Unticked → removed from that source. Paused / Closed → removed from all.
//     Draft / Agreement Check → not posted ("Will post when the agreement is
//     Active"); it posts by itself when the job goes live (openParkedJobs →
//     jobPosting.autoPost → syncAll).
//   * Every publish / update / retry / remove is an audit row
//     (entity RequirementPosting, fromValue = the source).
//   * Credentials are read only server side (integrationStore.readConfig —
//     encrypted at rest) and are masked out of every message.
//
// CONNECTOR SHAPE — every source answers the same calls:
//   publish / update / remove / status (r, row) -> { status, externalJobId?,
//   externalUrl?, errorMessage?, called? }
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { requirementIsLive, requirementStatusLabel } = require('./atsVocab');
const http = require('./jobBoards/http');
const indeed = require('./jobBoards/indeed');
const linkedin = require('./jobBoards/linkedin');
const google = require('./jobBoards/google');
const { naukri, shine } = require('./jobBoards/partner');

const ENTITY = 'RequirementPosting';
const INTEGRATIONS_PAGE = '/admin/integrations';
const SELF_TIMEOUT_MS = 8000;
const RECHECK_MS = 10 * 60 * 1000; // a waiting board is asked again at most every 10 minutes

// Lazy — jobPosting.js requires this module.
// eslint-disable-next-line global-require
const posting = () => require('./jobPosting');

const BOARDS = { indeed, linkedin, naukri, shine };
// In the order the form and the job page show them.
const SOURCES = [
  { id: 'jobportal', label: 'TeamLink Job Portal', kind: 'own' },
  { id: 'website', label: 'Website', kind: 'own' },
  { id: 'google', label: 'Google Jobs', kind: 'google', integrationId: 'google-jobs' },
  { id: 'naukri', label: 'Naukri', kind: 'board', integrationId: 'naukri' },
  { id: 'indeed', label: 'Indeed', kind: 'board', integrationId: 'indeed', autoCheck: true },
  { id: 'shine', label: 'Shine', kind: 'board', integrationId: 'shine' },
  { id: 'linkedin', label: 'LinkedIn', kind: 'board', integrationId: 'linkedin', autoCheck: true },
];
const sourceById = (id) => SOURCES.find((s) => s.id === id) || null;

const STATUS = {
  POSTED: 'Posted',
  FAILED: 'Failed',
  NEEDS: 'Integration Required',
  PENDING: 'Pending', // sent, the board has not confirmed yet
  FEED: 'Submitted to feed', // in our feed the board pulls; not confirmed by the board
  REMOVED: 'Removed',
  // Save & Post spec §4: a row exists from the moment Save & Post runs.
  QUEUED: 'Queued', // saved, the site's turn has not come yet
  POSTING: 'Posting', // the call to the site is running now
  RETRYING: 'Retrying', // the same, started by Retry
  // INTEGRATION REQUIRED = no employer / partner / feed arrangement entered at
  // all; SETUP REQUIRED = one was entered but a required item is missing.
  SETUP: 'Setup Required',
};
const WAITING = [STATUS.PENDING, STATUS.FEED];
const IN_FLIGHT = [STATUS.QUEUED, STATUS.POSTING, STATUS.RETRYING];
const STALE_MS = 3 * 60 * 1000; // an in-flight row older than this was interrupted (restart)
const isStale = (row) => row && IN_FLIGHT.includes(row.status) && Date.now() - new Date(row.updatedAt || row.lastTriedAt || 0).getTime() > STALE_MS;

const relOrAbs = (p) => http.publicUrl(p) || p;
const careersPath = (r, src) => require('./jobSlug').careersPath(r, src); // eslint-disable-line global-require

// ---------------------------------------------------------------------------
// STORE — RequirementPosting (migration 20261005150000_requirement_posting).
// Falls back to memory if the table were ever missing, so a save never breaks.
// ---------------------------------------------------------------------------
const memory = new Map();
const hasTable = () => !!prisma.requirementPosting;
const memKey = (rid, source) => `${rid}|${source}`;

async function rowsOf(requirementId) {
  if (hasTable()) {
    try { return await prisma.requirementPosting.findMany({ where: { requirementId } }); } catch { /* table missing */ }
  }
  return [...memory.values()].filter((r) => r.requirementId === requirementId);
}
async function saveRow(requirementId, source, data) {
  const now = new Date();
  if (hasTable()) {
    try {
      return await prisma.requirementPosting.upsert({
        where: { requirementId_source: { requirementId, source } },
        create: { requirementId, source, ...data },
        update: data,
      });
    } catch (err) {
      if (!/does not exist|no such table/i.test(String(err.message))) throw err;
    }
  }
  const k = memKey(requirementId, source);
  const prev = memory.get(k) || { id: k, requirementId, source, attempts: 0, createdAt: now };
  const next = { ...prev, ...data, updatedAt: now };
  memory.set(k, next);
  return next;
}
async function dropRow(requirementId, source) {
  if (hasTable()) {
    try { await prisma.requirementPosting.deleteMany({ where: { requirementId, source } }); return; } catch { /* table missing */ }
  }
  memory.delete(memKey(requirementId, source));
}

// ---------------------------------------------------------------------------
// OUR OWN SITES — confirmed by fetching the job back from our public URL.
// ---------------------------------------------------------------------------
const selfBase = () => `http://127.0.0.1:${process.env.PORT || 4010}`;
async function selfGet(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SELF_TIMEOUT_MS);
  try {
    const res = await fetch(`${selfBase()}${path}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: true, code: res.status, body };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally { clearTimeout(t); }
}
// The rule each public route applies (routes/careersPublic.js isListed,
// routes/public.js jobs.feed / jobs/:id/jsonld) — used only if our own URL
// could not be fetched.
async function listedInDb(id, site) {
  const r = await prisma.requirement.findUnique({ where: { id } });
  // eslint-disable-next-line global-require
  if (site === 'jobportal') return require('../routes/careersPublic').isListed(r);
  if (!r || !r.portalPublished || !requirementIsLive(r.status) || !posting().siteTicked(r, site)) return false;
  return site !== 'google' || !r.internal;
}

const OWN_CHECK = {
  // The embedded portal at /jobs: connector below (portalConnector). Only the
  // job's link is read from here (siteStatuses keeps saved rows up to date).
  jobportal: {
    url: (r) => require('./jobPortalBridge').jobUrl(r.id), // eslint-disable-line global-require
    where: 'the TeamLink Job Portal (/jobs)',
  },
  website: {
    path: () => '/api/public/jobs.feed',
    listed: (res, r) => res.code === 200 && Array.isArray(res.body) && res.body.some((j) => j.id === r.id),
    url: (r) => relOrAbs(careersPath(r, 'TeamLink Website')),
    where: 'the website job list',
  },
  google: {
    path: (r) => `/api/public/jobs/${r.id}/jsonld`,
    listed: (res) => res.code === 200 && res.body && res.body['@type'] === 'JobPosting',
    url: (r) => relOrAbs(`/api/public/jobs/${r.id}/jsonld`),
    where: 'our Google Jobs data',
  },
};

async function ownIsListed(site, r) {
  const c = OWN_CHECK[site];
  const res = await selfGet(c.path(r));
  if (res.ok && res.code !== 429 && res.code < 500) return { listed: c.listed(res, r), via: `GET ${c.path(r)} → ${res.code}` };
  return { listed: await listedInDb(r.id, site), via: 'checked in the database (own URL not reachable)' };
}
const notShowing = (r, where) => `The job is not showing on ${where} yet.${r.portalUnpublishedAt && !r.portalPublished ? ' It was taken off the job portal by hand — press Retry to put it back.' : ' Press Retry.'}`;

function ownConnector(site) {
  const c = OWN_CHECK[site];
  async function check(r) {
    const { listed, via } = await ownIsListed(site, r);
    if (listed) return { status: STATUS.POSTED, externalJobId: r.reqCode || r.id, externalUrl: c.url(r), note: via };
    return { status: STATUS.FAILED, errorMessage: notShowing(r, c.where), note: via };
  }
  return {
    publish: check,
    update: check,
    status: check,
    async remove(r) {
      const { listed, via } = await ownIsListed(site, r);
      if (!listed) return { status: STATUS.REMOVED, note: via };
      return { status: STATUS.POSTED, externalUrl: c.url(r), errorMessage: `Could not take it off ${c.where} yet. Press Retry.`, note: via };
    },
  };
}

// TEAMLINK JOB PORTAL — the customer's portal, embedded at /jobs (utils/
// jobPortalEmbed.js). The job is SENT to the portal (jobPortalBridge.
// pushRequirement), then the portal itself is asked whether it is live (its
// public job endpoint, the one its own job page reads). "Posted" only on that
// answer; never from this database alone.
function portalConnector() {
  const bridge = () => require('./jobPortalBridge'); // eslint-disable-line global-require
  const { where } = OWN_CHECK.jobportal;
  const url = (r) => OWN_CHECK.jobportal.url(r);
  const notAnswering = (seen) => `The job portal is not answering right now (${seen.reason}). Press Retry in a minute.`;
  async function up(r) {
    const sent = await bridge().pushRequirement(r.id);
    const seen = await bridge().portalJobLive(r.id);
    if (seen.live) return { status: STATUS.POSTED, externalJobId: r.reqCode || r.id, externalUrl: url(r), note: seen.via };
    if (seen.unreachable) return { status: STATUS.FAILED, errorMessage: notAnswering(seen) };
    return {
      status: STATUS.FAILED,
      errorMessage: sent.ok ? notShowing(r, where) : `The job could not be sent to the job portal: ${sent.error}. Press Retry.`,
      note: seen.via,
    };
  }
  return {
    publish: up,
    update: up,
    async status(r) {
      const seen = await bridge().portalJobLive(r.id);
      if (seen.live) return { status: STATUS.POSTED, externalJobId: r.reqCode || r.id, externalUrl: url(r), note: seen.via };
      return { status: STATUS.FAILED, errorMessage: seen.unreachable ? notAnswering(seen) : notShowing(r, where), note: seen.via };
    },
    async remove(r) {
      await bridge().pushRequirement(r.id); // closes it there (unticked / not live)
      const seen = await bridge().portalJobLive(r.id);
      if (!seen.live && !seen.unreachable) return { status: STATUS.REMOVED, note: seen.via };
      return {
        status: STATUS.POSTED,
        externalUrl: url(r),
        errorMessage: seen.unreachable ? notAnswering(seen) : `Could not take it off ${where} yet. Press Retry.`,
        note: seen.via,
      };
    },
  };
}

// Google: our JobPosting data (checked at its URL) + the Indexing API.
function googleConnector() {
  const own = ownConnector('google');
  async function up(r) {
    const mine = await own.publish(r);
    if (mine.status !== STATUS.POSTED) return mine;
    const cfg = await google.config();
    const base = { externalJobId: mine.externalJobId, externalUrl: mine.externalUrl, note: mine.note };
    if (!cfg.ready) {
      return {
        ...base,
        status: STATUS.FEED,
        errorMessage: cfg.missing && cfg.missing.length === 2
          ? 'Ready for Google on our site. Google usually shows new jobs within a few days.'
          : `Ready for Google on our site. Google usually shows new jobs within a few days. ${cfg.hint}`,
      };
    }
    const sent = await google.notify(r, cfg, 'URL_UPDATED');
    if (!sent.ok) return { ...base, status: STATUS.FEED, errorMessage: `Ready for Google on our site, but Google could not be told yet: ${sent.error}`, called: true };
    const seen = await google.inspect(r, cfg);
    if (seen.ok && seen.live) return { ...base, status: STATUS.POSTED, externalUrl: google.pageUrl(r), called: true };
    return { ...base, status: STATUS.FEED, errorMessage: 'Google was told about the job. It shows Posted once Google shows it (can take a few days).', called: true };
  }
  return {
    publish: up,
    update: up,
    async status(r, row) {
      const cfg = await google.config();
      if (!cfg.ready || !row || row.status !== STATUS.FEED) return up(r);
      const seen = await google.inspect(r, cfg);
      if (seen.ok && seen.live) return { status: STATUS.POSTED, externalUrl: google.pageUrl(r), called: true };
      return { status: STATUS.FEED, errorMessage: row.errorMessage, called: true };
    },
    async remove(r, row) {
      const mine = await own.remove(r);
      const cfg = await google.config();
      if (cfg.ready && row && [STATUS.POSTED, STATUS.FEED].includes(row.status)) {
        const sent = await google.notify(r, cfg, 'URL_DELETED');
        if (!sent.ok && mine.status === STATUS.REMOVED) return { ...mine, errorMessage: `Off our site; Google could not be told yet: ${sent.error}`, called: true };
        return { ...mine, called: true };
      }
      return mine;
    },
  };
}

// What people see when a board has no account yet: short and plain. The full
// "what to get and from whom" is on the board's Integrations card (desc +
// Test result) for the Admin.
// The user's own sentence (2026-10-05), then exactly what is missing.
const NOT_CONFIGURED = 'Real-time posting is not configured for this source. Connect the required employer integration in Administration → Integrations.';
const FIELD_WORDS = { naukri: { 'API key': 'Amplify API key' } };
function setupOf(src, cfg) {
  const words = FIELD_WORDS[src.id] || {};
  const missing = (cfg.missing || []).map((m) => words[m] || m);
  return {
    status: cfg.configured ? STATUS.SETUP : STATUS.NEEDS,
    message: missing.length ? `${NOT_CONFIGURED}\nMissing: ${missing.join(', ')}` : NOT_CONFIGURED,
  };
}
const peopleHint = (src, cfg) => setupOf(src, cfg).message;

// A board that PULLS an XML feed from us (Naukri, when its posting method is
// "XML feed"): the job is checked in our feed at its URL. Being in the feed
// is "Sent, waiting for confirmation" — never Posted; generating XML is not
// a confirmation from the board.
async function feedCheck(src, r, wantIn) {
  const path = `/api/public/feeds/${src.id}.xml`;
  const res = await selfGetText(path);
  const inFeed = res.ok && res.code === 200 && res.text.includes(`<referencenumber><![CDATA[${r.id}]]></referencenumber>`);
  const note = res.ok ? `GET ${path} → ${res.code}` : 'feed not reachable';
  if (wantIn) {
    return inFeed
      ? { status: STATUS.FEED, externalJobId: r.reqCode || r.id, errorMessage: `In the ${src.label} job feed. Waiting for ${src.label} to confirm it is live.`, note }
      : { status: STATUS.FAILED, errorMessage: `The job is not in the ${src.label} feed yet. Press Retry.`, note };
  }
  return inFeed
    ? { status: STATUS.FEED, errorMessage: `Still in the ${src.label} feed. Press Retry.`, note }
    : { status: STATUS.REMOVED, note };
}
async function selfGetText(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SELF_TIMEOUT_MS);
  try {
    const res = await fetch(`${selfBase()}${path}`, { signal: ctl.signal });
    return { ok: true, code: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally { clearTimeout(t); }
}

// A board: Integration Required until its account is set up; then its module.
function boardConnector(src) {
  const mod = BOARDS[src.id];
  const needs = (cfg) => { const x = setupOf(src, cfg); return { status: x.status, errorMessage: x.message }; };
  return {
    async publish(r, row) {
      const cfg = await mod.config();
      if (!cfg.ready) return needs(cfg);
      if (cfg.feed) return feedCheck(src, r, true);
      return mod.publish(r, row, cfg);
    },
    async update(r, row) {
      const cfg = await mod.config();
      if (!cfg.ready) return { status: STATUS.POSTED, errorMessage: `Changes were not sent: ${cfg.hint}` };
      if (cfg.feed) return feedCheck(src, r, true);
      return mod.update(r, row, cfg);
    },
    async remove(r, row) {
      if (!row || ![STATUS.POSTED, ...WAITING].includes(row.status)) return { status: STATUS.REMOVED };
      const cfg = await mod.config();
      if (cfg.feed || row.status === STATUS.FEED) return feedCheck(src, r, false);
      if (!cfg.ready) return { status: row.status, errorMessage: `Could not take it off ${src.label}: ${cfg.hint}` };
      return mod.remove(r, row, cfg);
    },
    async status(r, row) {
      const cfg = await mod.config();
      if (!cfg.ready) return needs(cfg);
      return mod.status(r, row, cfg);
    },
  };
}

const CONNECTORS = Object.fromEntries(SOURCES.map((s) => {
  if (s.id === 'jobportal') return [s.id, portalConnector()];
  if (s.kind === 'own') return [s.id, ownConnector(s.id)];
  if (s.kind === 'google') return [s.id, googleConnector()];
  return [s.id, boardConnector(s)];
}));

// ---------------------------------------------------------------------------
// RUNNING THEM
// ---------------------------------------------------------------------------
// One run per job at a time, so two quick saves never post the job twice.
const locks = new Map();
function serial(rid, fn) {
  const prev = locks.get(rid) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(rid, next);
  next.catch(() => {}).finally(() => { if (locks.get(rid) === next) locks.delete(rid); });
  return next;
}

async function audit(ctx, r, src, action, detail) {
  await logAudit({
    userId: ctx.actorId || null,
    actorName: ctx.actorName || (ctx.actorId ? null : 'System'),
    action: ctx.trigger === 'retry' ? `Retry — ${action}` : action,
    entity: ENTITY,
    entityId: r.id,
    fromValue: src.label,
    toValue: detail ? http.plain(detail, 500) : null,
  }).catch(() => {});
}

// What the job needs on each source right now: 'up' or 'down'.
function wanted(r) {
  const live = requirementIsLive(r.status);
  const ticked = posting().tickedSites(r);
  return Object.fromEntries(SOURCES.map((s) => {
    let want = live && ticked.includes(s.id) ? 'up' : 'down';
    if (s.id === 'google' && r.internal) want = 'down'; // internal hiring stays on our own sites
    return [s.id, want];
  }));
}

async function runOne(r, src, row, want, ctx) {
  const conn = CONNECTORS[src.id];
  const now = new Date();
  const tries = (row ? row.attempts || 0 : 0) + 1;
  try {
    if (want === 'down') {
      if (!row || row.status === STATUS.REMOVED) return row;
      // Never live there (Integration Required / Failed): nothing to take down.
      if (![STATUS.POSTED, ...WAITING].includes(row.status)) { await dropRow(r.id, src.id); return null; }
      const out = await conn.remove(r, row);
      const gone = out.status === STATUS.REMOVED;
      const saved = await saveRow(r.id, src.id, {
        status: out.status,
        externalJobId: out.externalJobId || row.externalJobId || null,
        errorMessage: out.errorMessage || null,
        removedAt: gone ? now : row.removedAt || null,
        attempts: tries,
        lastTriedAt: now,
      });
      await audit(ctx, r, src, gone ? 'Removed' : 'Remove failed',
        gone ? `Taken off ${src.label} — job is ${requirementStatusLabel(r.status)}${requirementIsLive(r.status) ? ' (unticked)' : ''}${out.note ? ` · ${out.note}` : ''}` : out.errorMessage);
      return saved;
    }

    const isPosted = row && row.status === STATUS.POSTED;
    const isWaiting = row && WAITING.includes(row.status) && !!row.externalJobId;
    // A background status check never re-sends a job that is already up.
    if (ctx.trigger === 'check' && !isWaiting) return row;
    // A status move between two live statuses changes nothing on a board.
    if (ctx.trigger === 'status' && src.kind === 'board' && (isPosted || isWaiting)) return row;
    if (!isPosted && !(isWaiting && ctx.trigger === 'check')) {
      await saveRow(r.id, src.id, { status: ctx.trigger === 'retry' ? STATUS.RETRYING : STATUS.POSTING, errorMessage: null, lastTriedAt: now });
    }
    const callStart = Date.now();
    let out;
    if (isPosted) out = await conn.update(r, row);
    // LinkedIn has no upsert: a job it is still processing is asked, not sent again.
    else if (isWaiting && (ctx.trigger === 'check' || src.id === 'linkedin')) out = await conn.status(r, row);
    else out = await conn.publish(r, row);
    const posted = out.status === STATUS.POSTED;
    const data = {
      status: out.status,
      externalJobId: out.externalJobId || (row && row.externalJobId) || null,
      externalUrl: out.externalUrl || (row && row.externalUrl) || null,
      errorMessage: out.errorMessage || null,
      postedAt: posted ? ((row && row.postedAt) || now) : (row ? row.postedAt || null : null),
      removedAt: null,
      attempts: tries,
      lastTriedAt: now,
    };
    const changed = !row || row.status !== data.status || (row.errorMessage || null) !== data.errorMessage;
    const saved = await saveRow(r.id, src.id, data);
    await recordBoard(src, out, callStart);
    // Audit: every real call to a board, every status change, every retry.
    if (out.called || changed || ctx.trigger === 'retry') {
      let action;
      if (posted) action = out.errorMessage ? 'Update failed' : (isPosted ? 'Updated' : 'Posted');
      else if (out.status === STATUS.NEEDS) action = 'Integration required';
      else if (out.status === STATUS.SETUP) action = 'Setup required';
      else if (out.status === STATUS.FEED) action = 'Submitted to feed';
      else if (out.status === STATUS.PENDING) action = 'Sent, waiting for the site';
      else action = 'Post failed';
      const detail = [out.errorMessage, data.externalJobId ? `id ${data.externalJobId}` : '', posted ? data.externalUrl : '', out.note || ''].filter(Boolean).join(' · ');
      await audit(ctx, r, src, action, detail);
    }
    return saved;
  } catch (err) {
    // One source failing never fails the job or the other sources.
    console.error(`[job-connectors] ${src.id} for requirement ${r.id}: ${http.scrub(err.message)}`);
    const saved = await saveRow(r.id, src.id, {
      status: row && row.status === STATUS.POSTED ? STATUS.POSTED : STATUS.FAILED,
      errorMessage: 'Something went wrong while posting. Press Retry.',
      attempts: tries,
      lastTriedAt: now,
    }).catch(() => null);
    await audit(ctx, r, src, 'Post failed', 'Something went wrong while posting.');
    return saved;
  }
}

// Sync the job on every source (or only `only`, a list of source ids).
// ctx: { actorId, actorName, trigger: create|edit|status|retry|post|check, only }
function syncAll(requirementId, ctx = {}) {
  return serial(requirementId, async () => {
    const r = await prisma.requirement.findUnique({ where: { id: requirementId } });
    if (!r) return { ok: false, error: 'no such requirement' };
    const want = wanted(r);
    const rows = await rowsOf(r.id);
    const only = Array.isArray(ctx.only) && ctx.only.length ? ctx.only : null;
    const list = SOURCES.filter((s) => !only || only.includes(s.id));
    const results = await Promise.allSettled(list.map((s) => runOne(r, s, rows.find((x) => x.source === s.id) || null, want[s.id], ctx)));
    return { ok: true, results: results.map((x, i) => ({ source: list[i].id, status: x.status === 'fulfilled' && x.value ? x.value.status : null })) };
  });
}
// QUEUED rows, written before the save answers (spec §4): every ticked site
// of a live job that is not already up gets its row at once.
async function markQueued(requirementId, ctx = {}) {
  if (ctx.trigger === 'check') return;
  const r = await prisma.requirement.findUnique({ where: { id: requirementId } });
  if (!r) return;
  const want = wanted(r);
  const rows = await rowsOf(r.id);
  const only = Array.isArray(ctx.only) && ctx.only.length ? ctx.only : null;
  await Promise.all(SOURCES.filter((src) => want[src.id] === 'up' && (!only || only.includes(src.id))).map((src) => {
    const row = rows.find((x) => x.source === src.id);
    if (row && [STATUS.POSTED, ...WAITING, STATUS.POSTING, STATUS.RETRYING].includes(row.status) && !isStale(row)) return null;
    return saveRow(r.id, src.id, { status: STATUS.QUEUED, errorMessage: null });
  }));
}
// Background version: the save never waits on a slow board (it only waits
// for the Queued rows, so the screen can show them straight away).
async function syncAllLater(requirementId, ctx = {}) {
  try { await markQueued(requirementId, ctx); } catch (e) { console.error(`[job-connectors] queue: ${http.scrub(e.message)}`); }
  setImmediate(() => { syncAll(requirementId, ctx).catch((e) => console.error(`[job-connectors] ${http.scrub(e.message)}`)); });
}

// The board's last good call / last error on its Integrations card
// (Integration.lastSync = last success; Integration.error = last error in
// plain words + the technical detail, never a secret).
async function recordBoard(src, out, callStart) {
  if (!src.integrationId || !out || !out.called) return;
  const d = http.lastDetail(src.label);
  const failed = !!(d && d.at.getTime() >= callStart);
  await prisma.integration.updateMany({
    where: { id: src.integrationId },
    data: failed
      ? { error: `${out.errorMessage || 'Failed'} — details: ${d.detail}`.slice(0, 900), recordsFailed: { increment: 1 } }
      : { lastSync: new Date(), error: null, recordsSynced: { increment: 1 } },
  }).catch(() => {});
}

// Retry: the failed / integration-required / waiting sources (or one source).
async function retry(requirementId, ctx = {}, source = null) {
  const rows = await rowsOf(requirementId);
  const r = await prisma.requirement.findUnique({ where: { id: requirementId } });
  if (!r) return { ok: false };
  const want = wanted(r);
  const ids = source ? [source] : SOURCES.map((s) => s.id).filter((id) => {
    const row = rows.find((x) => x.source === id);
    // "Retry failed": the ones that did not go through — never a Posted one,
    // never one that is sent and waiting for the site's confirmation.
    if (want[id] === 'up') return !row || [STATUS.FAILED, STATUS.NEEDS, STATUS.SETUP, STATUS.QUEUED, STATUS.REMOVED].includes(row.status) || isStale(row);
    return row && row.status === STATUS.POSTED && !!row.errorMessage; // a take-down that failed
  });
  if (!ids.length) return { ok: true, results: [] };
  return syncAll(requirementId, { ...ctx, trigger: 'retry', only: ids });
}

// Waiting boards that can be asked (Indeed, LinkedIn, Google with a service
// account) are asked again when the job page is opened, at most every 10 min.
async function recheckLater(r, rows) {
  const due = rows.filter((x) => WAITING.includes(x.status) && x.externalJobId
    && (!x.lastTriedAt || Date.now() - new Date(x.lastTriedAt).getTime() > RECHECK_MS)
    && (sourceById(x.source) || {}).kind !== 'own'
    && ((sourceById(x.source) || {}).autoCheck || x.source === 'google'));
  if (due.length) syncAllLater(r.id, { trigger: 'check', only: due.map((x) => x.source) });
  // A live job ticked for a site that has never been tried (a job saved
  // before Save & Post existed): post it there now, once.
  if (!r.portalPublished) return; // never published (or taken off by hand): the page offers Post now
  const want = wanted(r);
  const never = SOURCES.filter((s) => want[s.id] === 'up' && !rows.some((x) => x.source === s.id)).map((s) => s.id)
    .filter((id) => !firstTry.has(`${r.id}|${id}`));
  never.forEach((id) => firstTry.add(`${r.id}|${id}`));
  if (never.length) syncAllLater(r.id, { trigger: 'edit', only: never });
}
// Per process: a source is first-tried from a page view at most once per job.
const firstTry = new Set();

// ---------------------------------------------------------------------------
// WHAT PEOPLE SEE
// ---------------------------------------------------------------------------
// The word people see (simple-UX rule, 2026-10-05): no "feed", no jargon.
// Spec §4 codes, and the plain word people see for each.
const VIEW = {
  [STATUS.POSTED]: ['POSTED', '✓ Posted'],
  [STATUS.QUEUED]: ['QUEUED', '⏳ Queued'],
  [STATUS.POSTING]: ['POSTING', '⏳ Posting…'],
  [STATUS.RETRYING]: ['RETRYING', '⏳ Retrying…'],
  [STATUS.PENDING]: ['POSTING', '⏳ Sent, waiting for confirmation'],
  [STATUS.FEED]: ['POSTING', '⏳ Sent, waiting for confirmation'],
  [STATUS.FAILED]: ['FAILED', '✕ Failed'],
  [STATUS.NEEDS]: ['INTEGRATION_REQUIRED', '⚠ Integration required'],
  [STATUS.SETUP]: ['SETUP_REQUIRED', '⚠ Setup required'],
  [STATUS.REMOVED]: ['REMOVED', 'Removed'],
  Off: ['NOT_SELECTED', 'Not selected'],
  Waiting: ['WAITING_FOR_AGREEMENT', 'Waiting for agreement'],
  Draft: ['DRAFT', 'Draft'],
  'Not posted': ['NOT_POSTED', 'Not posted'],
  Paused: ['PAUSED', 'Paused'],
  Removing: ['REMOVING', 'Taking it off…'],
};
const TONE = {
  [STATUS.POSTED]: 'green', [STATUS.PENDING]: 'blue', [STATUS.FEED]: 'blue', [STATUS.NEEDS]: 'grey', [STATUS.SETUP]: 'grey', [STATUS.FAILED]: 'red', [STATUS.REMOVED]: 'grey',
  [STATUS.QUEUED]: 'blue', [STATUS.POSTING]: 'blue', [STATUS.RETRYING]: 'blue',
};

async function canSetUp(user) {
  if (!user) return false;
  // eslint-disable-next-line global-require
  const { can } = require('./permissions');
  try { return !!(await can(user, null, 'administration', 'Integrations', 'configure')); } catch { return false; } // can() is async
}

// The Posting Sources the form offers, each with whether it can post now.
async function sourceChoices(user) {
  const setUp = await canSetUp(user);
  const siteOf = (id) => posting().SITES.find((x) => x.id === id);
  return Promise.all(SOURCES.map(async (s) => {
    const base = { id: s.id, name: s.label, source: siteOf(s.id).source, kind: s.kind };
    if (s.kind === 'own') return { ...base, ready: true, hint: null, readyText: 'Posts at once' };
    if (s.kind === 'google') {
      const cfg = await google.config();
      return { ...base, ready: true, hint: null, readyText: 'Posts at once (Google shows it within a few days)' };
    }
    const cfg = await BOARDS[s.id].config();
    return {
      ...base, ready: cfg.ready, hint: cfg.ready ? null : peopleHint(s, cfg), setupStatus: cfg.ready ? null : setupOf(s, cfg).status, readyText: cfg.ready ? `Sent to ${s.label} at once` : null, setupLink: !cfg.ready && setUp ? INTEGRATIONS_PAGE : null,
    };
  }));
}

// One row per source for the job page.
//   { id, name, kind, ticked, status, tone, reason, canRetry, link,
//     externalJobId, postedAt, lastTriedAt, retryCount, setupLink }
async function siteStatuses(r, user = null) {
  const rows = await rowsOf(r.id);
  // Our own links follow the readable slug (/careers/<slug>); a row saved
  // before the slug existed is brought up to date here — our URL, no call out.
  await Promise.all(rows.filter((x) => ['jobportal', 'website'].includes(x.source) && x.externalUrl).map((x) => {
    const want = OWN_CHECK[x.source].url(r);
    if (x.externalUrl === want) return null;
    x.externalUrl = want; // eslint-disable-line no-param-reassign
    return saveRow(r.id, x.source, { externalUrl: want }).catch(() => null);
  }));
  const ticked = posting().tickedSites(r);
  const live = requirementIsLive(r.status);
  const label = requirementStatusLabel(r.status);
  const choices = await sourceChoices(user);
  if (live) recheckLater(r, rows).catch(() => {});
  const notLive = (() => {
    if (r.status === 'AGREEMENT_CHECK') return { status: 'Waiting', tone: 'orange', reason: 'Will post when the agreement is Active.' };
    if (r.status === 'DRAFT') return { status: 'Draft', tone: 'grey', reason: 'This job is a draft. It posts when the job is opened.' };
    if (r.status === 'ON_HOLD') return { status: 'Paused', tone: 'orange', reason: 'The job is paused, so it is off this site. It goes back up when the job is resumed.' };
    return { status: 'Removed', tone: 'grey', reason: `The job is ${label}, so it is off this site.` };
  })();

  return SOURCES.map((s) => withLabel(s, rows.find((x) => x.source === s.id) || null));

  function withLabel(s, row) {
    const v = statusOf(s, row);
    const [code, label] = VIEW[v.status] || [String(v.status).toUpperCase(), v.status];
    return { ...v, code, label, waiting: WAITING.includes(v.status) };
  }
  function statusOf(s, row) {
    const isTicked = ticked.includes(s.id);
    const choice = choices.find((c) => c.id === s.id);
    const shownId = row && row.externalJobId && BOARDS[s.id] ? BOARDS[s.id].shownId(row.externalJobId) : (row ? row.externalJobId : null);
    const base = {
      id: s.id,
      name: s.label,
      kind: s.kind,
      ticked: isTicked,
      canRetry: false,
      link: row && row.status === STATUS.POSTED ? row.externalUrl || null : null,
      externalJobId: shownId || null,
      postedAt: row ? row.postedAt || null : null,
      lastTriedAt: row ? row.lastTriedAt || null : null,
      retryCount: row ? row.attempts || 0 : 0, // RequirementPosting.attempts
      setupLink: choice ? choice.setupLink || null : null,
    };
    // Off this source but still up there (a remove that did not go through).
    if ((!isTicked || !live) && row && [STATUS.POSTED, ...WAITING].includes(row.status)) {
      return { ...base, status: 'Removing', tone: row.errorMessage ? 'red' : 'blue', reason: row.errorMessage || 'Taking it off this site…', canRetry: !!row.errorMessage };
    }
    if (!isTicked) return { ...base, status: 'Off', tone: 'none', reason: 'Not ticked for this job.' };
    if (s.id === 'google' && r.internal) return { ...base, status: 'Off', tone: 'none', reason: 'TeamLink internal hiring stays on our own Job Portal and Website.' };
    if (!live) return { ...base, ...notLive };
    if (!row && !r.portalPublished) {
      return { ...base, status: 'Not posted', tone: 'grey', reason: r.portalUnpublishedAt ? 'Taken off by hand. Press Post now to put it back.' : 'Not posted yet. Press Post now.', canRetry: true };
    }
    if (!row) {
      if (s.kind === 'board' && choice && !choice.ready) return { ...base, status: choice.setupStatus || STATUS.NEEDS, tone: TONE[STATUS.NEEDS], reason: choice.hint, canRetry: false };
      return { ...base, status: STATUS.QUEUED, tone: TONE[STATUS.QUEUED], reason: 'Waiting for its turn…' };
    }
    if (row.status === STATUS.REMOVED) return { ...base, status: STATUS.QUEUED, tone: TONE[STATUS.QUEUED], reason: 'Putting it back up…' };
    if (isStale(row)) return { ...base, status: STATUS.FAILED, tone: TONE[STATUS.FAILED], reason: 'The last try was interrupted. Press Retry.', canRetry: true };
    if (IN_FLIGHT.includes(row.status)) return { ...base, status: row.status, tone: TONE[row.status], reason: row.status === STATUS.QUEUED ? 'Waiting for its turn…' : `Sending to ${s.label}…` };
    let reason = row.errorMessage || '';
    if (row.status === STATUS.POSTED && !row.errorMessage) {
      const when = new Date(row.postedAt || row.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      reason = `Live since ${when}${shownId && s.kind === 'board' ? ` · ${s.label} job id ${shownId}` : ''}.`;
    }
    if (!reason && row.status === STATUS.FAILED) reason = 'It did not go through. Press Retry.';
    return {
      ...base,
      status: row.status,
      tone: row.status === STATUS.POSTED && row.errorMessage ? 'orange' : (TONE[row.status] || 'grey'),
      reason,
      // Needs account setup: the button is the setup link; once set up, Retry.
      canRetry: [STATUS.FAILED, ...WAITING].includes(row.status) || (row.status === STATUS.POSTED && !!row.errorMessage)
        || ([STATUS.NEEDS, STATUS.SETUP].includes(row.status) && !!(choice && choice.ready)),
    };
  }
}

// Administration → Integrations: what a board connector needs, and how it
// stands (used by the Test button of a job-board card).
async function boardSetupReport(integrationId) {
  const src = SOURCES.find((s) => s.integrationId === integrationId);
  if (!src) return null;
  const cfg = src.kind === 'google' ? await google.config() : await BOARDS[src.id].config();
  let last = null;
  if (hasTable()) {
    last = await prisma.requirementPosting.findFirst({ where: { source: src.id }, orderBy: { updatedAt: 'desc' } }).catch(() => null);
  }
  const lastText = last ? ` Last job: ${last.status}${last.errorMessage ? ` (${http.plain(last.errorMessage, 140)})` : ''}.` : '';
  return {
    ready: cfg.ready,
    result: cfg.ready
      ? `Ready — TeamLink sends jobs to ${src.label} on the next Save & Post (nothing was sent by this test).${lastText}`
      : `Not ready — ${cfg.hint}${lastText}`,
  };
}

// The job-board card on Administration → Integrations (spec §14): connection,
// account id, posting method, last success, last error (plain + details).
// Never a credential.
const ACCOUNT_FIELD = {
  naukri: 'Recruiter account email', shine: 'Recruiter account email', indeed: 'Employer ID (optional)', linkedin: 'Organization ID', 'google-jobs': 'Search Console property URL',
};
const METHOD_TEXT = {
  indeed: 'API (Indeed Job Sync, partner)', linkedin: 'API (LinkedIn Job Posting, partner)', shine: 'Partner API (from Shine)', 'google-jobs': 'Our job data + Google Indexing API',
};
async function boardStatus(integrationId) {
  const src = SOURCES.find((s) => s.integrationId === integrationId);
  if (!src) return null;
  const cfg = src.kind === 'google' ? await google.config() : await BOARDS[src.id].config();
  const row = await prisma.integration.findUnique({ where: { id: integrationId } });
  // eslint-disable-next-line global-require
  const { readConfig } = require('./integrationStore');
  const values = (await readConfig(integrationId)).values || {};
  const counts = hasTable()
    ? await prisma.requirementPosting.groupBy({ by: ['status'], where: { source: src.id }, _count: { _all: true } }).catch(() => [])
    : [];
  const n = (sts) => counts.filter((c) => sts.includes(c.status)).reduce((a, c) => a + c._count._all, 0);
  const err = row && row.error ? String(row.error) : '';
  const [plainErr, details] = err.includes(' — details: ') ? err.split(' — details: ') : [err, ''];
  let feedRead = null;
  if (cfg.feed) {
    const fr = await prisma.appSetting.findUnique({ where: { key: `feed.${src.id}.lastRead` } }).catch(() => null);
    try { feedRead = fr ? JSON.parse(fr.value) : null; } catch { feedRead = null; }
  }
  let connection = 'Not set up';
  if (row && row.connected === false && row.values) connection = 'Switched off';
  else if (cfg.ready && plainErr) connection = 'Error';
  else if (cfg.ready) connection = 'Ready';
  return {
    id: integrationId,
    source: src.id,
    name: src.label,
    connection,
    ready: !!cfg.ready,
    hint: cfg.ready ? null : cfg.hint,
    account: values[ACCOUNT_FIELD[integrationId]] || null,
    method: cfg.method || (cfg.feed ? 'XML feed' : METHOD_TEXT[integrationId] || null),
    methods: integrationId === 'naukri' ? ['Amplify API', 'XML feed'] : null,
    feedUrl: cfg.feed ? relOrAbs(`/api/public/feeds/${src.id}.xml`) : null,
    feedLastRead: feedRead,
    lastSuccessAt: row && row.lastSync ? row.lastSync : null,
    lastError: plainErr || null,
    lastErrorDetails: details || null,
    jobs: { posted: n([STATUS.POSTED]), waiting: n(WAITING), failed: n([STATUS.FAILED]), setup: n([STATUS.NEEDS, STATUS.SETUP]) },
  };
}

module.exports = {
  boardStatus,
  SOURCES, STATUS, VIEW, CONNECTORS, sourceById,
  syncAll, syncAllLater, retry, siteStatuses, sourceChoices, rowsOf, boardSetupReport,
  BOARD_FIELDS: {
    indeed: indeed.FIELDS, linkedin: linkedin.FIELDS, naukri: naukri.FIELDS, shine: shine.FIELDS, 'google-jobs': google.FIELDS,
  },
};
