// Clients > Duplicate clients. Super Admin / Admin only: find groups of the
// same company stored under several spellings, preview a merge, and merge a
// group into one client (see utils/clientDedupe.js for the rules).
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { roleForProduct } = require('../utils/permissions');
const {
  computeGroups, previewMerge, mergeClients, mergeSafeGroups, mergeHistory, MergeError,
} = require('../utils/clientDedupe');

const router = express.Router();
router.use(requireAuth);

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];
const isSaAdmin = (u) => !!u && (ADMIN_ROLES.includes(u.role) || ADMIN_ROLES.includes(roleForProduct(u, 'ats')));
router.use((req, res, next) => {
  if (!isSaAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or Admin can review duplicate clients' });
  return next();
});

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
    res.json(await computeGroups());
  } catch (err) { next(err); }
});

// For the small "Duplicate clients (N)" button on the Clients page.
router.get('/count', async (req, res, next) => {
  try {
    const { summary, junk } = await computeGroups();
    res.json({ groups: summary.all.groups, removable: summary.all.removable, safe: summary.SAFE.groups, junk: junk.length });
  } catch (err) { next(err); }
});

// Exactly what a merge would do, without doing it (the confirm dialog).
router.post('/preview', async (req, res, next) => {
  try {
    const { primaryId, donorIds, name } = req.body || {};
    res.json(await previewMerge({ primaryId: String(primaryId || ''), donorIds: bodyIds(donorIds), name }));
  } catch (err) { fail(res, err, next); }
});

router.post('/merge', async (req, res, next) => {
  const { primaryId, donorIds, name, splitOut } = req.body || {};
  try {
    await exclusive(res, async () => {
      const result = await mergeClients({
        primaryId: String(primaryId || ''), donorIds: bodyIds(donorIds), name, splitOut: bodyIds(splitOut), user: req.user,
      });
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

router.get('/history', async (req, res, next) => {
  try {
    res.json({ merges: await mergeHistory() });
  } catch (err) { next(err); }
});

module.exports = router;
