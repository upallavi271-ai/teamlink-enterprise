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
    const live = requirementIsLive(r.status);
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
        toValue: r.internal
          ? 'TeamLink Job Portal, careers page (internal hire — not in the job-board feed)'
          : 'TeamLink Job Portal, careers page, job-board feeds (Naukri, Indeed, LinkedIn, Shine)',
      });
      await audit(ctx, r, 'Auto-posted', 'Careers page', 'Listed on the careers page and the website feed');
      if (!r.internal) await audit(ctx, r, 'Auto-posted', 'Job board feeds', 'In the XML / JSON-LD job feeds boards pull');
    } else if (change === 'taken-down') {
      await logAudit({
        userId: ctx.actorId || null, actorName: ctx.actorName || null,
        action: 'Requirement taken down from all sources', entity: 'Requirement', entityId: r.id,
        fromValue: 'Published', toValue: `Requirement is ${requirementStatusLabel(r.status)}`,
      });
      await audit(ctx, r, 'Auto-removed', 'Careers page', `Requirement is ${requirementStatusLabel(r.status)}`);
      if (!r.internal) await audit(ctx, r, 'Auto-removed', 'Job board feeds', `Requirement is ${requirementStatusLabel(r.status)}`);
    }

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
// "Posted on" — per-source status for the requirement page.
// ---------------------------------------------------------------------------
async function postingChannels(r) {
  const live = requirementIsLive(r.status);
  const published = !!r.portalPublished;
  const statusText = requirementStatusLabel(r.status);
  const portalCfg = bridge.status();

  const [lastFailure, manual, integrations, manualLog] = await Promise.all([
    prisma.syncLog.findFirst({
      where: { recordRef: r.id, status: 'Failed', reason: { startsWith: 'Job Portal push failed' } },
      orderBy: { createdAt: 'desc' },
    }),
    manuallyUnpublished(r),
    prisma.integration.findMany({ where: { id: { in: JOB_BOARDS.map((b) => b.id) } }, select: { id: true, connected: true, state: true } }),
    prisma.auditLog.findMany({
      where: { entity: POSTING_ENTITY, entityId: r.id, fromValue: { in: JOB_BOARDS.map((b) => b.name) } },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true } } },
      take: 40,
    }),
  ]);

  const notLive = r.portalPublishedAt
    ? { status: 'Taken down', tone: 'grey', detail: `Requirement is ${statusText} — removed automatically.` }
    : { status: 'Not posted', tone: 'grey', detail: `Requirement is ${statusText} — it posts automatically when it goes live.` };
  const unpublishedByHand = manual
    ? { status: 'Not posted', tone: 'amber', detail: `Unpublished by ${manual.by || 'a user'} on ${new Date(manual.at).toLocaleDateString('en-IN')} — press Retry to post it again.` }
    : { status: 'Pending', tone: 'amber', detail: 'Will be posted on the next save or sync — press Retry to post now.' };

  // 1. TeamLink Job Portal — really pushed, really confirmed.
  let portal;
  if (!portalCfg.configured) {
    portal = { status: 'Not configured', tone: 'grey', detail: 'JOB_PORTAL_SYNC_TOKEN / JOB_PORTAL_PUSH_SECRET are not set in backend/.env.' };
  } else if (!live) portal = notLive;
  else if (!published) portal = unpublishedByHand;
  else if (r.portalSyncStatus === 'Synced') {
    portal = { status: 'Posted', tone: 'green', detail: `Open on the TeamLink Job Portal since ${new Date(r.portalPublishedAt || r.updatedAt).toLocaleDateString('en-IN')}.`, link: bridge.jobUrl(r.id) };
  } else if (r.portalSyncStatus === 'Failed') {
    const why = lastFailure ? lastFailure.reason.replace(/^Job Portal push failed:\s*/, '') : 'the last push did not go through';
    portal = { status: 'Failed', tone: 'red', detail: `Not on the portal: ${why}.`, reason: why, at: lastFailure ? lastFailure.createdAt : null };
  } else {
    portal = { status: 'Pending', tone: 'amber', detail: 'Published — waiting for the portal to confirm.' };
  }

  // 2. Careers page + website feed — served from this database, so it is
  // exactly as posted as the requirement is published.
  let careers;
  if (!live) careers = notLive;
  else if (!published) careers = unpublishedByHand;
  else careers = { status: 'Posted', tone: 'green', detail: 'On the public careers page and the website job feed.', link: `/careers/${r.id}`, feed: FEED_PATHS.json };

  const channels = [
    { id: 'jobportal', name: 'TeamLink Job Portal', kind: 'push', retry: true, ...portal },
    { id: 'careers', name: 'Careers page & website feed', kind: 'feed', ...careers },
  ];

  // 3. Job boards — feed-based (no posting API is implemented).
  const connected = new Map(integrations.map((i) => [i.id, i.connected]));
  JOB_BOARDS.forEach((b) => {
    const entries = manualLog.filter((l) => l.fromValue === b.name);
    const lastManual = entries.find((l) => ['Posted manually', 'Removed'].includes(l.action));
    let st;
    if (r.internal) {
      st = { status: 'Not applicable', tone: 'grey', detail: 'TeamLink internal hire — kept to TeamLink’s own channels (Job Portal, careers page).' };
    } else if (!live) st = notLive;
    else if (!published) st = unpublishedByHand;
    else if (lastManual && lastManual.action === 'Posted manually') {
      st = { status: 'Posted', tone: 'green', detail: `Posted manually by ${lastManual.user ? lastManual.user.name : 'a user'} on ${new Date(lastManual.createdAt).toLocaleDateString('en-IN')}.`, link: lastManual.toValue || null };
    } else {
      st = {
        status: 'Feed ready',
        tone: 'blue',
        detail: connected.get(b.id)
          ? `${b.name} is marked connected, but TeamLink has no ${b.name} posting API — the job is in the XML feed ${b.name} pulls.`
          : `In the XML job feed — connect in Integrations (register the feed URL in your ${b.name} employer account) and ${b.name} collects it.`,
        feed: FEED_PATHS.xml,
      };
    }
    channels.push({ id: b.id, name: b.name, kind: 'board', ...st });
  });

  return {
    live,
    published,
    publishedAt: day(r.portalPublishedAt),
    unpublishedAt: day(r.portalUnpublishedAt),
    internal: !!r.internal,
    channels,
    feeds: FEED_PATHS,
    summary: {
      posted: channels.filter((c) => c.status === 'Posted').length,
      feedReady: channels.filter((c) => c.status === 'Feed ready').length,
      failed: channels.filter((c) => c.status === 'Failed').length,
      pending: channels.filter((c) => c.status === 'Pending').length,
    },
  };
}

module.exports = { autoPost, postingChannels, JOB_BOARDS, FEED_PATHS };
