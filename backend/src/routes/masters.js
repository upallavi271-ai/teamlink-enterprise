// GET /api/masters — THE LIVE MASTER LISTS for every dropdown.
//
// "When a role is added, it must automatically appear in the dropdowns"
// (the user's rule, 2026-09-29). Every HRMS / Administration picker —
// Add / Edit Employee, Users, the HRMS filters — reads its roles,
// designations, departments, teams, branches, statuses … from here
// (frontend/src/utils/masters.js useMasters()), never from a hard-coded
// array. The lists are built by utils/masters.js masterLists().
//
// Any signed-in INTERNAL login may read it (Client / Candidate logins have
// their own portal). Departments and teams are cut to the caller's own
// department scope, exactly as GET /admin/departments does, so a scoped lead
// is never offered a department they cannot reach.
//
// Cheap to re-check: the body carries `version` and the response a weak
// ETag of it, so a client revalidating with If-None-Match gets a 304.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireInternal } = require('../utils/permissions');
const { scopeDepartments } = require('../utils/scope');
const { masterLists } = require('../utils/masters');

const router = express.Router();
router.use(requireAuth);
router.use(requireInternal);

router.get('/', async (req, res, next) => {
  try {
    const lists = await masterLists({ departments: scopeDepartments(req.user) });
    const etag = `W/"m-${lists.version}"`;
    res.set('Cache-Control', 'private, no-cache');
    res.set('ETag', etag);
    const inm = String(req.headers['if-none-match'] || '');
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) return res.status(304).end();
    return res.json(lists);
  } catch (err) {
    return next(err);
  }
});

// GET /api/masters/version — just the cache-bust key.
router.get('/version', async (req, res, next) => {
  try {
    const { version } = await masterLists({ departments: scopeDepartments(req.user) });
    res.set('Cache-Control', 'private, no-cache');
    return res.json({ version });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
