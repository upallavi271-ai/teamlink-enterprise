// Clients > Duplicate clients. Super Admin / Admin only: find groups of the
// same company stored under several spellings, preview a merge, and merge a
// group into one client (see utils/clientDedupe.js for the rules).
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { roleForProduct } = require('../utils/permissions');
const {
  computeGroups, previewMerge, mergeClients, mergeSafeGroups, mergeHistory, undoMerge, MergeError,
} = require('../utils/clientDedupe');

const router = express.Router();
router.use(requireAuth);
router.use(require('../utils/hrDesk').blockHrDesk);

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];
const isSaAdmin = (u) => !!u && (ADMIN_ROLES.includes(u.role) || ADMIN_ROLES.includes(roleForProduct(u, 'ats')));
// BDE (user rule 2026-10-13: everything client-related except delete): the client's BDE merges duplicates among THEIR OWN
// clients, the BDE TL among all; the whole-company tools (merge-safe, plan, apply-plan, history) stay Admin only.
const CLX = require('../utils/clientLifecycle');
const prismaM = require('../db');
const isBdeUser = (u) => !!u && (require('../utils/scope').isBdeTl(u) || CLX.isDeskBde(u)); // eslint-disable-line global-require
async function bdeMergeIds(u) {
  if (require('../utils/scope').isBdeTl(u)) return null; // eslint-disable-line global-require
  return { has: (id) => !!id, user: u }; // real check per row below (desk department)
}
router.use(async (req, res, next) => {
  if (isSaAdmin(req.user)) return next();
  if (isBdeUser(req.user) && ['/groups', '/count', '/preview', '/merge', '/undo', '/history'].includes(req.path)
    && await require('../middleware/auth').can(req.user, 'ats', 'clients', 'Client Merge Request', 'create')) { // eslint-disable-line global-require
    req.bdeOwn = await bdeMergeIds(req.user);
    return next();
  }
  return res.status(403).json({ error: 'Only a Super Admin or Admin can review duplicate clients. A BDE merges their own clients.' });
});
// every id of a BDE's merge must be one of their own clients
async function bdeIdsOk(req, ids) {
  if (!req.bdeOwn) return true; // admin, or the BDE TL (all)
  const rows = await prismaM.client.findMany({ where: { id: { in: ids.map(String) } }, select: { id: true, ownerDepartment: true } });
  return rows.length === new Set(ids.map(String)).size && rows.every((r) => CLX.ownsClient(req.user, r));
}

// One merge at a time across the whole app — two people merging overlapping
// groups at once must not interleave.
let busy = false;
async function exclusive(res, fn) {
  if (busy) return res.status(409).json({ error: 'Another merge is running — try again in a moment' });
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}
const fail = (res, err, next) => {
  if (err instanceof MergeError) return res.status(err.status || 400).json({ error: err.message });
  return next(err);
};
const bodyIds = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

router.get('/groups', async (req, res, next) => {
  try {
    res.json(await computeGroups(prismaM, req.bdeOwn ? { only: (r) => CLX.ownsClient(req.user, r) } : {}));
  } catch (err) { next(err); }
});

// For the small "Duplicate clients (N)" button on the Clients page.
router.get('/count', async (req, res, next) => {
  try {
    const { summary, junk } = await computeGroups(prismaM, req.bdeOwn ? { only: (r) => CLX.ownsClient(req.user, r) } : {});
    res.json({ groups: summary.all.groups, removable: summary.all.removable, safe: summary.SAFE.groups, junk: junk.length });
  } catch (err) { next(err); }
});

// Exactly what a merge would do, without doing it (the confirm dialog).
router.post('/preview', async (req, res, next) => {
  try {
    const { primaryId, donorIds, name } = req.body || {};
    if (!(await bdeIdsOk(req, [primaryId, ...bodyIds(donorIds)]))) return res.status(403).json({ error: 'You can merge only your own clients.' });
    res.json(await previewMerge({ primaryId: String(primaryId || ''), donorIds: bodyIds(donorIds), name }));
  } catch (err) { fail(res, err, next); }
});

router.post('/merge', async (req, res, next) => {
  const { primaryId, donorIds, name, splitOut } = req.body || {};
  if (!(await bdeIdsOk(req, [primaryId, ...bodyIds(donorIds), ...bodyIds(splitOut)]))) return res.status(403).json({ error: 'You can merge only your own clients.' });
  try {
    await exclusive(res, async () => {
      const result = await mergeClients({
        primaryId: String(primaryId || ''), donorIds: bodyIds(donorIds), name, splitOut: bodyIds(splitOut), user: req.user,
      });
      await require('../utils/audit').logAudit({ userId: req.user.id, actorName: req.user.name || null, action: 'Clients merged', entity: 'Client', entityId: String(primaryId || ''), toValue: `${bodyIds(donorIds).length} duplicate(s) merged into this client`, reason: String((req.body && req.body.reason) || '').trim().slice(0, 500) || null }); // eslint-disable-line global-require
      res.json(result);
    });
  } catch (err) { fail(res, err, next); }
});

router.post('/merge-safe', async (req, res, next) => {
  const { groupIds, all } = req.body || {};
  const ids = bodyIds(groupIds);
  if (!ids.length && all !== true) return res.status(400).json({ error: 'Pass groupIds, or all: true to merge every SAFE group' });
  try {
    await exclusive(res, async () => {
      res.json(await mergeSafeGroups({ groupIds: ids.length ? ids : null, user: req.user }));
    });
  } catch (err) { fail(res, err, next); }
  return undefined;
});

// READ-ONLY: the recommended plan (utils/clientDedupe.js computePlan), for review.
router.get('/plan', async (req, res, next) => {
  try {
    res.json(await require('../utils/clientDedupe').computePlan());
  } catch (err) { next(err); }
});

// APPLY the recommended plan — only when a Super Admin / Admin presses
// "Merge all recommended" on the Duplicate clients page and types MERGE.
// A full copy of the database is written FIRST (VACUUM INTO backups/…); if
// that copy cannot be made, nothing is merged. Each merge set is its own
// transaction and is recorded in ClientMerge (with the deleted rows'
// snapshot), so the run is traceable and a failure in one set leaves the
// others intact.
router.post('/apply-plan', async (req, res, next) => {
  if (String((req.body && req.body.confirm) || '') !== 'MERGE') {
    return res.status(400).json({ error: 'Type MERGE to confirm merging every recommended group.' });
  }
  try {
    await exclusive(res, async () => {
      const path = require('path');
      const fs = require('fs');
      const prisma = require('../db');
      const dir = path.join(__dirname, '..', '..', 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const backup = path.join(dir, `dev.db.before-client-merge.${stamp}`);
      try {
        await prisma.$executeRawUnsafe(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      } catch (err) {
        return res.status(500).json({ error: `Could not back up the database first, so nothing was merged: ${err.message}` });
      }
      const before = await prisma.client.count();
      const result = await require('../utils/clientDedupe').applyPlan({ user: req.user });
      const after = await prisma.client.count();
      return res.json({ ...result, before, after, backup: path.basename(backup) });
    });
  } catch (err) { fail(res, err, next); }
  return undefined;
});

// The merge history: all of it for an Admin; a BDE sees the merges of THEIR desk (the survivor is a desk client).
router.get('/history', async (req, res, next) => {
  try {
    let merges = await mergeHistory();
    if (req.bdeOwn !== undefined) {
      const primaries = await prismaM.client.findMany({ where: { id: { in: merges.map((m) => m.primaryId) } }, select: { id: true, ownerDepartment: true } });
      const okIds = new Set(primaries.filter((p) => CLX.ownsClient(req.user, p) || !req.bdeOwn).map((p) => p.id));
      merges = merges.filter((m) => okIds.has(m.primaryId));
    }
    if (req.query.primaryId) merges = merges.filter((m) => m.primaryId === String(req.query.primaryId));
    res.json({ merges });
  } catch (err) { next(err); }
});

// UNDO a merge (7 days): Admin any; a BDE only a merge of their desk's clients; the BDE TL any.
router.post('/undo', async (req, res, next) => {
  try {
    const rec = await prismaM.clientMerge.findUnique({ where: { id: String((req.body && req.body.mergeId) || '') } });
    if (!rec) return res.status(404).json({ error: 'That merge was not found.' });
    if (req.bdeOwn) {
      let snap = []; try { snap = JSON.parse(rec.donorSnapshot || '[]'); } catch { snap = []; }
      const p = await prismaM.client.findUnique({ where: { id: rec.primaryId }, select: { id: true, ownerDepartment: true } });
      if (!p || ![p, ...snap].every((c) => CLX.ownsClient(req.user, c))) return res.status(403).json({ error: 'You can undo only a merge of your own desk\'s clients.' });
    }
    await exclusive(res, async () => {
      const out = await undoMerge({ mergeId: rec.id, user: req.user, reason: req.body && req.body.reason });
      res.json(out);
    });
  } catch (err) { fail(res, err, next); }
});

module.exports = router;
