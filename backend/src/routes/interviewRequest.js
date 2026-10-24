// ---------------------------------------------------------------------------
// /api/ats - "ASK THE CLIENT MANAGER TO BOOK" (utils/interviewRequest.js).
//
//   POST /interviews/:id/ask-book     (:id = the application)  a Recruiter / TL / STL ... asks the job's BDE to book
//   GET  /interviews/:id/ask-book     can this login ask for this candidate, and has someone asked already?
//
// Only a login that CANNOT book asks (the BDE, the BDE TL, HR for internal jobs and Admin book themselves). The
// application must be inside the caller's own area. No phone, email or salary is ever sent or returned.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { can } = require('../utils/permissions');
const { applicationWhere, OUT_OF_SCOPE } = require('../utils/scope');
const IR = require('../utils/interviewRequest');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const mayBook = async (user) => (await can(user, 'ats', 'interviews', 'Schedule Interview', 'create'));
// who may ask: a login that works the pipeline (sees applications) but cannot book
const mayAsk = async (user) => !(await mayBook(user)) && (await can(user, 'ats', 'candidates', 'Applications', 'view'));

async function loadScoped(req, res) {
  const app = await prisma.application.findFirst({
    where: { id: req.params.id, ...applicationWhere(req.user) },
    select: { id: true, candidateId: true, stage: true, interviewStatus: true },
  });
  if (app) return app;
  const exists = await prisma.application.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (exists) res.status(403).json(OUT_OF_SCOPE); else res.status(404).json({ error: 'Application not found' });
  return null;
}

router.get('/interviews/:id/ask-book', async (req, res, next) => {
  try {
    const app = await loadScoped(req, res); if (!app) return undefined;
    const st = IR.askState(app);
    const map = await IR.requestsFor([app.id]);
    const prior = map.get(app.id) || null;
    return res.json({ canAsk: st.ok && (await mayAsk(req.user)), reason: st.ok ? null : st.reason, requested: prior ? { by: prior.by, at: prior.at, line: IR.lineOf(prior) } : null });
  } catch (err) { return next(err); }
});

router.post('/interviews/:id/ask-book', async (req, res, next) => {
  try {
    if (await mayBook(req.user)) return res.status(409).json({ error: 'You can book this interview yourself.' });
    if (!(await mayAsk(req.user))) return res.status(403).json({ error: "This action isn't included in your role's permissions" });
    const app = await loadScoped(req, res); if (!app) return undefined;
    const out = await IR.ask(req.user, app.id);
    return res.status(out.status).json(out.body);
  } catch (err) { return next(err); }
});

module.exports = router;
