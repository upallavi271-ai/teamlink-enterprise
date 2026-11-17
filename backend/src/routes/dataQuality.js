// DATA QUALITY REPORT (utils/dataQuality.js), mounted at /api/ats/data-quality. Admin, Manager, STL, TL. Cached 10 minutes
// (it reads every profile). GET /?fresh=1 recounts now.
const express = require('express');
const DQ = require('../utils/dataQuality');
const { requireAuth } = require('../middleware/auth');
const { scopeOf } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);
const OK = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL'];
let cache = null;
router.get('/', async (req, res, next) => {
  try {
    const roles = [req.user.role, req.user.atsRole, req.user.hrmsRole].filter(Boolean);
    if (!roles.some((r) => OK.includes(r)) && !scopeOf(req.user).adminGlobal) return res.status(403).json({ error: 'The data quality report is for team leads and above.' });
    if (!cache || req.query.fresh === '1' || Date.now() - cache.at > 600000) cache = { at: Date.now(), data: await DQ.report() };
    return res.json(cache.data);
  } catch (e) { return next(e); }
});
module.exports = router;
