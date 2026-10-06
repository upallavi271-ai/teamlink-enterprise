// ---------------------------------------------------------------------------
// POSTING TO EVERY SOURCE (user notes #7).
//
// "When a requirement is added / posted, it must be posted to and visible on
// all sources." This module is that rule, in one place:
//
//   autoPost(requirementId, ctx)
//     called after a requirement is created, edited, bulk-changed or moves
//     status. A LIVE requirement is published (portalPublished) — which is what
//     puts it on the TeamLink Job Portal (pushed through utils/jobPortalBridge),
//     on the public careers page / website feed (routes/public.js jobs.feed)
//     and in the job-board XML feed (jobs.xml). A requirement that is CLOSED,
//     ON HOLD, DRAFT or held at Agreement Check is taken down everywhere at
//     once. Every post, take-down and failure is written to the audit trail.
//
//   postingChannels(requirement)
//     the per-source status the requirement page shows in "Posted on":
//     Posted / Pending / Failed (+ reason) / Not configured / Feed ready /
//     Not posted / Taken down / Not applicable.
//
// HONESTY ABOUT JOB BOARDS. Naukri, Indeed, LinkedIn and Shine are entries in
// the Integrations catalogue with no posting API implemented behind them (see
// utils/adminCatalog.js LIVE_CHANNELS). Nothing here pretends to have posted
// on them. What they get is real: an Indeed-format XML feed
// (/api/public/jobs.xml) and a schema.org JobPosting feed (/api/public/
// jobs.jsonld, Google-for-Jobs shape) that a board pulls once the feed URL is
// registered in the employer account. Those channels read "Feed ready —
// connect in Integrations" until someone records a manual post.
//
// INTERNAL REQUIREMENTS (TeamLink Internal Hire) go to TeamLink's own
// channels — the Job Portal and the careers page — and are kept out of the
// external job-board feed.
//
// MANUAL CHOICE IS RESPECTED. Somebody who unpublished a live requirement on
// purpose (Job Portal workspace → Unpublish) is not overruled by the next
// edit; only a status change that brings it back to life (reopen / activate)
// or an explicit Retry publishes it again.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const bridge = require('./jobPortalBridge');
const { requirementIsLive, requirementStatusLabel } = require('./atsVocab');

const JOB_BOARDS = [
  { id: 'naukri', name: 'Naukri' },
  { id: 'indeed', name: 'Indeed' },
  { id: 'linkedin', name: 'LinkedIn' },
  { id: 'shine', name: 'Shine' },
];
const FEED_PATHS = { xml: '/api/public/jobs.xml', json: '/api/public/jobs.feed', jsonld: '/api/public/jobs.jsonld' };
const POSTING_ENTITY = 'RequirementPosting';

const day = (d) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------------------
// THE SIX SITES (ATS change list §5 "Posting" / §16, 2026-10-03). On a job
// the user ticks the sites; each tick is stored by name in
// Requirement.postingSources (no migration). Nothing recorded yet (null / '')
// means "the free sites" — Job Portal, Website, Google Jobs — which is what
// user notes #7 asked for ("posted to all sources"). Unticking everything is
// stored as 'None' so it is not read back as "nothing recorded".
//   free  Job Portal (our own app, pushed), Website + Google Jobs (feeds this
//         app serves: /api/public/jobs.feed and /api/public/jobs.jsonld)
//   paid  Naukri, Shine, Indeed — no account / API: "Needs account"
// ---------------------------------------------------------------------------
const SITES = [
  { id: 'jobportal', name: 'Job Portal', source: 'TeamLink Job Portal', kind: 'free' },
  { id: 'naukri', name: 'Naukri', source: 'Naukri', kind: 'paid' },
  { id: 'shine', name: 'Shine', source: 'Shine', kind: 'paid' },
  { id: 'indeed', name: 'Indeed', source: 'Indeed', kind: 'paid' },
  // Save & Post (2026-10-05): LinkedIn is a source too (partner API, utils/jobBoards/linkedin.js).
  { id: 'linkedin', name: 'LinkedIn', source: 'LinkedIn', kind: 'paid' },
  { id: 'website', name: 'Website', source: 'TeamLink Website', kind: 'free' },
  { id: 'google', name: 'Google Jobs', source: 'Google Jobs', kind: 'free' },
];
const FREE_SITE_IDS = SITES.filter((s) => s.kind === 'free').map((s) => s.id);
const PUBLIC_SITE_IDS = ['jobportal', 'website', 'google'];
const NONE_TICKED = 'None';
const siteCsv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
// The ticked site ids. Nothing recorded -> the free sites.
function tickedSites(r) {
  const raw = r ? r.postingSources : null;
  if (raw == null || String(raw).trim() === '') return [...FREE_SITE_IDS];
  const names = siteCsv(raw);
  if (names.length === 1 && names[0] === NONE_TICKED) return [];
  return SITES.filter((s) => names.includes(s.source) || names.includes(s.name)).map((s) => s.id);
}
const siteTicked = (r, id) => tickedSites(r).includes(id);
// Does the job belong on ANY public channel (portal, careers page, feeds)?
const wantsPublic = (r) => tickedSites(r).some((id) => PUBLIC_SITE_IDS.includes(id));
// The stored value for a set of ticked ids. Other names already in the field
// that are not one of the six (e.g. "Social Media") are kept.
function postingSourcesFor(r, ids) {
  const keep = siteCsv(r && r.postingSources).filter((n) => n !== NONE_TICKED && !SITES.some((s) => s.source === n || s.name === n));
  const names = [...SITES.filter((s) => ids.includes(s.id)).map((s) => s.source), ...keep];
  return names.length ? names.join(', ') : NONE_TICKED;
}

// Was the requirement last unpublished BY A PERSON (Job Portal workspace),
// rather than taken down automatically when it closed?
async function manuallyUnpublished(r) {
  if (r.portalPublished || !r.portalUnpublishedAt) return null;
  const last = await prisma.auditLog.findFirst({
    where: {
      entity: 'Requirement', entityId: r.id,
      action: { in: ['Requirement unpublished from job portal', 'Requirement published to job portal', 'Requirement auto-posted to all sources', 'Requirement taken down from all sources'] },
    },
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { name: true } } },
  });
  if (last && last.action === 'Requirement unpublished from job portal') {
    return { by: last.user ? last.user.name : null, at: last.createdAt };
  }
  return null;
}

async function audit(ctx, r, action, source, detail) {
  await logAudit({
    userId: ctx.actorId || null,
    actorName: ctx.actorName || (ctx.actorId ? null : 'System'),
    action,
    entity: POSTING_ENTITY,
    entityId: r.id,
    fromValue: source,
    toValue: detail ? String(detail).slice(0, 500) : null,
  });
}

// Push to the Job Portal and audit the outcome. Never throws.
async function pushAndAudit(r, ctx, what) {
  const push = await bridge.pushRequirement(r.id);
  if (push.skipped) return push;
  if (!push.ok) {
    await audit(ctx, r, 'Post failed', 'TeamLink Job Portal', push.error);
  } else if (what) {
    await audit(ctx, r, what, 'TeamLink Job Portal', push.status === 'open' ? 'Open on the portal' : 'Closed on the portal');
  }
  return push;
}

// ctx: { actorId, actorName, trigger: 'create'|'edit'|'status'|'retry', prevStatus, background }
async function autoPost(requirementId, ctx = {}) {
  try {
    const r = await prisma.requirement.findUnique({ where: { id: requirementId } });
    if (!r) return { ok: false, skipped: 'no such requirement' };
    // A job whose ticks name no public site is kept off every public channel.
    const live = requirementIsLive(r.status) && wantsPublic(r);
    // A status move between two live statuses is not a reopen.
    const revived = ctx.trigger === 'create' || ctx.trigger === 'retry'
      || (ctx.trigger === 'status' && !requirementIsLive(ctx.prevStatus));
    let change = null;

    if (live && !r.portalPublished) {
      const manual = revived ? null : await manuallyUnpublished(r);
      if (!manual) {
        await prisma.requirement.update({
          where: { id: r.id },
          data: {
            portalPublished: true,
            portalPublishedAt: new Date(),
            portalPublishedBy: ctx.actorId || null,
            portalUnpublishedAt: null,
            portalSyncStatus: 'Pending',
          },
        });
        change = 'posted';
      }
    } else if (!live && r.portalPublished) {
      await prisma.requirement.update({
        where: { id: r.id },
        data: { portalPublished: false, portalUnpublishedAt: new Date(), portalSyncStatus: 'Not Synced' },
      });
      change = 'taken-down';
    }

    if (change === 'posted') {
      await logAudit({
        userId: ctx.actorId || null, actorName: ctx.actorName || null,
        action: 'Requirement auto-posted to all sources', entity: 'Requirement', entityId: r.id,
        fromValue: 'Not published',
        // Each ticked site's real result is its own RequirementPosting audit row
        // (utils/jobConnectors.js) — nothing here claims a board posted it.
        toValue: 'Published — posting to each ticked site (each site logs its own result)',
      });
    } else if (change === 'taken-down') {
      await logAudit({
        userId: ctx.actorId || null, actorName: ctx.actorName || null,
        action: 'Requirement taken down from all sources', entity: 'Requirement', entityId: r.id,
        fromValue: 'Published', toValue: `Requirement is ${requirementStatusLabel(r.status)}`,
      });
    }

    // SAVE & POST (2026-10-05): every ticked source's own connector — post,
    // update, or take down — in the background, one result row per source
    // (utils/jobConnectors.js). Runs for every trigger, including a job that
    // goes live when its agreement turns Active (openParkedJobs).
    // eslint-disable-next-line global-require
    if (!ctx.skipSources) await require('./jobConnectors').syncAllLater(r.id, {
      actorId: ctx.actorId || null, actorName: ctx.actorName || null, trigger: ctx.sourceTrigger || ctx.trigger || 'edit',
    });

    // Never on the portal and nothing to do there.
    if (!change && !r.portalPublished && !r.portalPublishedAt) return { ok: true, change: null };

    const what = change === 'posted' ? 'Auto-posted' : change === 'taken-down' ? 'Auto-removed'
      : (ctx.trigger === 'retry' ? 'Retried' : (live && r.portalPublished ? 'Posting updated' : null));
    const run = () => pushAndAudit(r, ctx, what);
    if (ctx.background) {
      setImmediate(() => { run().catch(() => {}); });
      return { ok: true, change, pushed: 'queued' };
    }
    const push = await run();
    return { ok: push.ok !== false, change, push };
  } catch (err) {
    console.error(`[job-posting] requirement ${requirementId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// PER-SOURCE STATUS (Save & Post, 2026-10-05). Both views now read the
// stored result of each source's connector (utils/jobConnectors.js,
// RequirementPosting) — the job page card (siteStatuses) and the older
// "Posted on" panel / drawer line (postingChannels, same rows reshaped).
// ---------------------------------------------------------------------------
// eslint-disable-next-line global-require
const connectors = () => require('./jobConnectors');
async function siteStatuses(r, user = null) {
  return connectors().siteStatuses(r, user);
}
async function postingChannels(r, user = null) {
  const sites = await connectors().siteStatuses(r, user);
  const channels = sites.filter((s) => s.ticked || s.status !== 'Off').map((s) => ({
    id: s.id, name: s.name, kind: s.kind, status: s.status, tone: s.tone, detail: s.reason, reason: s.reason,
    link: s.link, retry: s.canRetry, externalJobId: s.externalJobId, postedAt: s.postedAt, retryCount: s.retryCount,
  }));
  const count = (st) => channels.filter((c) => c.status === st).length;
  return {
    live: requirementIsLive(r.status),
    published: !!r.portalPublished,
    publishedAt: day(r.portalPublishedAt),
    unpublishedAt: day(r.portalUnpublishedAt),
    internal: !!r.internal,
    channels,
    feeds: FEED_PATHS,
    summary: { posted: count('Posted'), feedReady: count('Submitted to feed'), failed: count('Failed'), pending: count('Pending'), integrationRequired: count('Integration Required') },
  };
}

// The Job Portal's failure in words a new joiner understands.
function plainPortalReason(raw) {
  const t = String(raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 'The Job Portal did not accept the job last time.';
  if (/not reachable/i.test(t)) return 'The Job Portal app was not running, so the job could not be sent. Start the Job Portal app, then press Retry.';
  if (/did not answer in time/i.test(t)) return 'The Job Portal was too slow to answer. Press Retry in a minute.';
  if (/Cannot (POST|PUT)/i.test(t) || /answered 404/i.test(t)) return 'The Job Portal app is an old version that cannot take jobs yet. Update the Job Portal app, then press Retry.';
  if (/answered 401|answered 403|token|secret/i.test(t)) return 'The Job Portal refused our key. Ask the Admin to check the Job Portal key on the server.';
  if (/SANDBOX/i.test(t)) return 'This is the test copy — the Job Portal is never contacted from here.';
  return `The Job Portal said: ${t.slice(0, 160)}`;
}

module.exports = {
  autoPost, postingChannels, JOB_BOARDS, FEED_PATHS,
  SITES, tickedSites, siteTicked, wantsPublic, postingSourcesFor, siteStatuses, plainPortalReason,
};
