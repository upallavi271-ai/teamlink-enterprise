// ---------------------------------------------------------------------------
// PortalPosting: the portal-side status of ONE job on ONE portal (the engine's own truth).
// DRAFT QUEUED PUBLISHED FAILED NEEDS_CHECK UNPUBLISHED EXPIRED
// PUBLISHED is written only by the runner, only with an id or a link AND a verified listing.
// ---------------------------------------------------------------------------
const {
  q, q1, ex, iso, newId,
} = require('./db');
const C = require('./constants');

const view = (r) => (r ? {
  id: r.id, requirementId: r.requirementId, portal: r.portal, portalName: C.portalName(r.portal), status: r.status, statusWords: C.PORTAL_WORDS[r.status] || r.status,
  portalJobId: r.portalJobId || null, portalUrl: r.portalUrl || null, publishedAt: iso(r.publishedAt), expiresAt: iso(r.expiresAt), autoRepublish: !!r.autoRepublish,
  lastError: r.lastError || null, lastQueueId: r.lastQueueId || null, lastAction: r.lastAction || null, verifiedAt: iso(r.verifiedAt), payloadHash: r.payloadHash || null, updatedAt: iso(r.updatedAt),
} : null);

const get = async (requirementId, portal) => q1('SELECT * FROM "PortalPosting" WHERE "requirementId" = ? AND "portal" = ?', requirementId, portal);
const forJob = async (requirementId) => (await q('SELECT * FROM "PortalPosting" WHERE "requirementId" = ?', requirementId));

// fields: any of status, portalJobId, portalUrl, publishedAt(ms), expiresAt, autoRepublish, lastError, lastQueueId, lastAction, payloadHash, verifiedAt
async function set(requirementId, portal, fields, userId = null) {
  const now = Date.now();
  const prev = await get(requirementId, portal);
  const f = { ...fields };
  if (!prev) {
    await ex(
      'INSERT INTO "PortalPosting" ("id","requirementId","portal","status","createdBy","updatedBy","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)',
      newId('pp'), requirementId, portal, f.status || 'DRAFT', userId, userId, now, now,
    );
  }
  const cols = Object.keys(f).filter((k) => ['status', 'portalJobId', 'portalUrl', 'publishedAt', 'expiresAt', 'autoRepublish', 'lastError', 'lastQueueId', 'lastAction', 'payloadHash', 'verifiedAt'].includes(k));
  if (cols.length) {
    await ex(
      `UPDATE "PortalPosting" SET ${cols.map((c) => `"${c}" = ?`).join(', ')}, "updatedBy" = ?, "updatedAt" = ? WHERE "requirementId" = ? AND "portal" = ?`,
      ...cols.map((c) => (typeof f[c] === 'boolean' ? (f[c] ? 1 : 0) : f[c])), userId, now, requirementId, portal,
    );
  }
  return view(await get(requirementId, portal));
}

module.exports = {
  view, get, forJob, set,
};
