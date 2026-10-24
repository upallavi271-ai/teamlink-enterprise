// ---------------------------------------------------------------------------
// THE BRIDGE TO THE EXISTING POSTING SCREENS (RequirementPosting, the by-hand task).
//
// The engine's own truth is PortalPosting. The job page's "Posted on" panel, the by-hand tasks and the reminders read
// RequirementPosting (utils/jobConnectors.js, utils/jobBoards/manual.js). This file keeps the two honest without
// changing any of that code:
//
//   onPublished   Naukri / Shine went live and VERIFIED -> the existing row becomes 'Posted by hand' (a status the old
//                 connectors leave alone, and take down by hand when the job closes), with the live link, the portal
//                 job id and the sentence "Posted by TeamLink automation". It is never written as 'Posted' (that word
//                 stays the board's own confirmation through the old connectors).
//   onRemoved     taken down by the engine -> 'Removed'
//   ensureHandTask  the engine cannot post (CAPTCHA, switch OFF, manual-only LinkedIn, credentials missing): the
//                 EXISTING by-hand task is created if missing and never touched if it exists. The job is never lost.
//
// Foundit has no legacy source (it is new): the engine's own status, queue and notification carry it.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const C = require('./constants');

const HAND_DONE = 'Posted by hand';
const NEEDS = 'Integration Required';
const legacyOf = (portal) => (C.PORTALS[portal] && C.PORTALS[portal].legacySource) || null;
const upsert = (requirementId, source, create, update) => prisma.requirementPosting.upsert({
  where: { requirementId_source: { requirementId, source } }, create: { requirementId, source, ...create }, update,
});

async function onPublished(portal, requirementId, { portalJobId, portalUrl, byName }) {
  const source = legacyOf(portal);
  if (!source) return null;
  const prev = await prisma.requirementPosting.findUnique({ where: { requirementId_source: { requirementId, source } } }).catch(() => null);
  const data = {
    status: HAND_DONE,
    externalJobId: portalJobId || null,
    externalUrl: portalUrl || null,
    postedAt: new Date(),
    removedAt: null,
    errorMessage: `Posted by TeamLink automation${byName ? ` (asked by ${byName})` : ''}`,
    attempts: (prev ? prev.attempts || 0 : 0) + 1,
    lastTriedAt: new Date(),
  };
  await upsert(requirementId, source, data, data);
  await logAudit({
    userId: null, actorName: byName || 'TeamLink automation', action: 'Posted by automation', entity: 'RequirementPosting', entityId: requirementId,
    fromValue: C.portalName(portal), toValue: portalUrl ? `Live link ${portalUrl}` : (portalJobId ? `id ${portalJobId}` : 'No link'),
  });
  return true;
}

async function onRemoved(portal, requirementId, { byName }) {
  const source = legacyOf(portal);
  if (!source) return null;
  const prev = await prisma.requirementPosting.findUnique({ where: { requirementId_source: { requirementId, source } } }).catch(() => null);
  if (!prev) return null;
  await prisma.requirementPosting.update({
    where: { requirementId_source: { requirementId, source } },
    data: { status: 'Removed', removedAt: new Date(), errorMessage: null, lastTriedAt: new Date() },
  });
  await logAudit({
    userId: null, actorName: byName || 'TeamLink automation', action: 'Taken down by automation', entity: 'RequirementPosting', entityId: requirementId, fromValue: C.portalName(portal), toValue: 'Removed',
  });
  return true;
}

// Create the existing by-hand task when it is missing. -> true when a task now exists
async function ensureHandTask(portal, requirementId, reason) {
  const source = legacyOf(portal);
  if (!source) return false;
  const prev = await prisma.requirementPosting.findUnique({ where: { requirementId_source: { requirementId, source } } }).catch(() => null);
  if (prev && [HAND_DONE, 'Posted', 'Take down by hand'].includes(prev.status)) return true; // a hand-post / live post is never overwritten
  if (prev && [NEEDS, 'Setup Required'].includes(prev.status)) return true; // the task is already there: keep it
  await upsert(requirementId, source, { status: NEEDS, errorMessage: String(reason || '').slice(0, 300) || null }, { status: NEEDS, errorMessage: String(reason || '').slice(0, 300) || null });
  await logAudit({
    userId: null, actorName: 'TeamLink automation', action: 'Waiting to post by hand', entity: 'RequirementPosting', entityId: requirementId, fromValue: C.portalName(portal),
    toValue: `${C.portalName(portal)} cannot be posted by TeamLink now: a person posts it by hand. ${String(reason || '').slice(0, 160)}`,
  });
  return true;
}

// the path of the existing by-hand helper (the screens open it)
const handPath = (portal, requirementId) => (legacyOf(portal) ? `/api/requirements/${requirementId}/posting-sites/${legacyOf(portal)}/by-hand` : null);

module.exports = {
  onPublished, onRemoved, ensureHandTask, legacyOf, handPath, HAND_DONE, NEEDS,
};
