// ---------------------------------------------------------------------------
// "POSTED ON" for the Jobs list (2026-10-13, extended 2026-10-14): per job, the places it is posted on.
//   * the sites the posting engine has a real row on (PortalPosting): state 'posted' ONLY when the status is PUBLISHED;
//   * the places a PERSON marked as posted by hand (DistPosting, jobDist/tracker.js): 'Posted by hand' / 'Expiring soon' /
//     'Expired'. Those are never shown as the system's own "Posted".
// Read-only; never posts anything.
//   forRows(ids)            -> Map(requirementId -> [{ portal, name, state, words, url, byHand? }])
//   idsFor(value)           -> null (no filter) | { include: [ids] } | { exclude: [ids] }
//                              value: any | none | expired | a place key (naukri, linkedin, apna, whatsapp ...)
//   counts(scopeIds)        -> { naukri: 3, foundit: 0, apna: 2 ... } jobs that are posted per place (engine + by hand)
// ---------------------------------------------------------------------------
const { q, supported } = require('./db');
const C = require('./constants');
const Track = require('../jobDist/tracker');
const Plat = require('../jobDist/platforms');

const STATE = {
  PUBLISHED: ['posted', 'Posted'], QUEUED: ['queued', 'Queued'], NEEDS_CHECK: ['needs_help', 'Needs your help'], FAILED: ['failed', 'Failed'],
};
const marks = (ids) => ids.map(() => '?').join(',');
const union = (...lists) => [...new Set(lists.flat())];

async function forRows(ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  if (await supported().catch(() => false)) {
    const rows = await q(`SELECT "requirementId" rid, "portal", "status", "portalUrl" FROM "PortalPosting" WHERE "requirementId" IN (${marks(ids)}) AND "status" IN ('PUBLISHED','QUEUED','NEEDS_CHECK','FAILED')`, ...ids);
    rows.forEach((r) => {
      const st = STATE[r.status];
      if (!st || !C.PORTALS[r.portal]) return;
      if (!out.has(r.rid)) out.set(r.rid, []);
      out.get(r.rid).push({ portal: r.portal, name: C.portalName(r.portal), state: st[0], words: st[1], url: r.status === 'PUBLISHED' ? (r.portalUrl || null) : null });
    });
  }
  // by hand: a place the engine already shows as posted is not listed twice
  const hand = await Track.forRows(ids).catch(() => new Map());
  hand.forEach((list, rid) => {
    const have = out.get(rid) || [];
    const extra = list.filter((h) => !have.some((x) => x.portal === h.portal && x.state === 'posted'));
    if (extra.length) out.set(rid, [...have, ...extra]);
  });
  return out;
}

const enginePublished = async (portal = null) => {
  if (!(await supported().catch(() => false))) return [];
  const rows = portal
    ? await q('SELECT DISTINCT "requirementId" rid FROM "PortalPosting" WHERE "status" = \'PUBLISHED\' AND "portal" = ?', portal)
    : await q('SELECT DISTINCT "requirementId" rid FROM "PortalPosting" WHERE "status" = \'PUBLISHED\'');
  return rows.map((r) => r.rid);
};

async function idsFor(value) {
  const v = String(value || '');
  if (!v) return null;
  if (v === 'none' || v === 'any') {
    const list = union(await enginePublished(), await Track.liveIds());
    return v === 'any' ? { include: list } : { exclude: list };
  }
  if (v === 'expired') {
    if (!(await Plat.ready())) return { include: [] };
    const rows = await q('SELECT DISTINCT "requirementId" rid FROM "DistPosting" WHERE "state" = \'POSTED\' AND "expiresAt" IS NOT NULL AND "expiresAt" <= ?', Date.now());
    return { include: rows.map((r) => r.rid) };
  }
  if (C.PORTALS[v]) return { include: union(await enginePublished(v), await Track.liveIds(v)) };
  const p = await Plat.get(v).catch(() => null);
  if (!p) return null;
  return { include: await Track.liveIds(v) };
}

async function counts(scopeIds) {
  const out = Object.fromEntries(C.PORTAL_KEYS.map((k) => [k, 0]));
  if (await supported().catch(() => false)) {
    const per = await q('SELECT "portal", "requirementId" rid FROM "PortalPosting" WHERE "status" = \'PUBLISHED\'');
    const set = scopeIds === null ? null : new Set(scopeIds || []);
    const seen = new Set();
    per.forEach((r) => { const k = `${r.portal}|${r.rid}`; if ((!set || set.has(r.rid)) && !seen.has(k) && r.portal in out) { seen.add(k); out[r.portal] += 1; } });
  }
  // by hand: a job counted for a place by the engine is not counted twice
  const hand = await Track.countSets(scopeIds === null ? null : (scopeIds || [])).catch(() => ({}));
  const engineSets = {};
  if (await supported().catch(() => false)) {
    const per = await q('SELECT "portal", "requirementId" rid FROM "PortalPosting" WHERE "status" = \'PUBLISHED\'');
    const set = scopeIds === null ? null : new Set(scopeIds || []);
    per.forEach((r) => { if (set && !set.has(r.rid)) return; (engineSets[r.portal] = engineSets[r.portal] || new Set()).add(r.rid); });
  }
  Object.keys(hand).forEach((k) => {
    const both = new Set([...(engineSets[k] || []), ...hand[k]]);
    out[k] = both.size;
  });
  return out;
}

module.exports = { forRows, idsFor, counts };
