// GET /api/ats/workers?department=&role=
//
// Everyone who worked the ATS records this caller can see — current and
// former — for the Recruiter / TL / BDE filters on every ATS screen, plus the
// seats in scope for the Position filter. Built by utils/workers.js; see the
// header there for who counts and how a record is attributed.
//
// Mounted ahead of the /api/ats routers, because those gate on the Interview
// Calendar permission and this list serves Requirements, Candidates, the
// calendar, Recruiter & BDE and ATS Reports alike: any one of those screens
// opens it. It never widens scope — the list is built inside the caller's own.
const express = require('express');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { listWorkers, hasPersonQuery, attributedApplications } = require('../utils/workers');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
// Outside logins (Client / Candidate) never use this internal surface —
// review #3 access audit; their screens are /api/portal/*.
router.use(require('../utils/permissions').requireInternal);

const SCREENS = [
  ['ats', 'requirements', 'Requirement List', 'view'],
  ['ats', 'candidates', 'Candidate List', 'view'],
  ['ats', 'interviews', 'Calendar View', 'view'],
  ['ats', 'recruiterbde', 'Team View', 'view'],
  [null, 'reports', 'ATS Reports', 'view'],
];

router.get('/', async (req, res, next) => {
  try {
    const allowed = await Promise.all(SCREENS.map((p) => can(req.user, ...p)));
    if (!allowed.some(Boolean)) {
      return res.status(403).json({ error: "This list isn't included in your role's permissions" });
    }
    const department = typeof req.query.department === 'string' ? req.query.department.trim() : '';
    const role = typeof req.query.role === 'string' ? req.query.role.trim().toUpperCase() : '';
    if (role && !['RECRUITER', 'TL', 'BDE'].includes(role)) {
      return res.status(400).json({ error: 'role must be RECRUITER, TL or BDE' });
    }
    return res.json(await listWorkers(req.user, { department, role }));
  } catch (err) {
    return next(err);
  }
});

// GET /api/ats/workers/applications?recruiter=&tl=&bde=&positionCode=
// The ids of the applications — inside the caller's scope — attributed to
// that person / seat (utils/workers.js attribution). For the screens that
// filter a list they already hold (Interview Feedback, Offers, Joining,
// Internal Hiring): the server decides whose work a record is, the screen
// only intersects.
router.get('/applications', async (req, res, next) => {
  try {
    const allowed = await Promise.all(SCREENS.map((p) => can(req.user, ...p)));
    if (!allowed.some(Boolean)) {
      return res.status(403).json({ error: "This list isn't included in your role's permissions" });
    }
    if (!hasPersonQuery(req.query)) return res.status(400).json({ error: 'Name a recruiter, tl, bde or positionCode' });
    const att = await attributedApplications(req.user, req.query);
    return res.json({ ids: [...att.ids] });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
