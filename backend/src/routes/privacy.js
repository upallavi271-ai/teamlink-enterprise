// ---------------------------------------------------------------------------
// CANDIDATE PRIVACY routes (utils/candidatePrivacy.js), mounted at /api/privacy. Super Admin / Admin, and HR for export.
//   GET    /candidates/:id                 { hold, erasable: { ok, why } }
//   GET    /candidates/:id/export          the person's data as a JSON file (audited)
//   POST   /candidates/:id/hold            { reason }       legal hold
//   DELETE /candidates/:id/hold            { reason? }
//   POST   /candidates/:id/erase           { reason, confirm: 'ERASE' }
//   GET    /consent                        consent review: older than N months / never recorded / withdrawn
//   PUT    /consent                        { months }
// ---------------------------------------------------------------------------
const express = require('express');
const P = require('../utils/candidatePrivacy');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { scopeOf } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);
const rolesOf = (u) => [u && u.role, u && u.hrmsRole, u && u.atsRole, u && u.accountsRole].filter(Boolean);
const isAdmin = (u) => rolesOf(u).some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r)) || !!scopeOf(u).adminGlobal;
const isHr = (u) => rolesOf(u).includes('HR');
const admins = (req, res, next) => (isAdmin(req.user) && !req.viewAs ? next() : res.status(403).json({ error: 'Only a Super Admin or an Admin can do this.' }));
const adminsOrHr = (req, res, next) => ((isAdmin(req.user) || isHr(req.user)) && !req.viewAs ? next() : res.status(403).json({ error: 'Only an Admin or HR can do this.' }));

router.get('/candidates/:id', adminsOrHr, async (req, res, next) => {
  try {
    const why = await P.erasureBlock(req.params.id);
    res.json({ hold: await P.holdOf(req.params.id), erasable: { ok: !why, why }, canErase: isAdmin(req.user) });
  } catch (e) { next(e); }
});
router.get('/candidates/:id/export', adminsOrHr, async (req, res, next) => {
  try {
    const out = await P.exportOf(req.params.id);
    if (!out) return res.status(404).json({ error: 'This candidate is not there.' });
    await logAudit({ userId: req.user.id, action: 'Candidate data exported (DPDP access request)', entity: 'Candidate', entityId: req.params.id, reason: String(req.query.reason || '').slice(0, 300) || null });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="candidate-data-${req.params.id}.json"`);
    return res.send(JSON.stringify(out, null, 2));
  } catch (e) { return next(e); }
});
router.post('/candidates/:id/hold', admins, async (req, res, next) => {
  try { const r = await P.hold(req.params.id, { reason: (req.body || {}).reason, user: req.user }); return r.error ? res.status(400).json(r) : res.json(r); } catch (e) { return next(e); }
});
router.delete('/candidates/:id/hold', admins, async (req, res, next) => {
  try { const r = await P.release(req.params.id, { reason: (req.body || {}).reason, user: req.user }); return r.error ? res.status(400).json(r) : res.json(r); } catch (e) { return next(e); }
});
router.post('/candidates/:id/erase', admins, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.confirm !== 'ERASE') return res.status(400).json({ error: 'Type ERASE to confirm. This cannot be undone.' });
    const r = await P.erase(req.params.id, { reason: b.reason, user: req.user });
    return r.error ? res.status(r.blocked ? 409 : 400).json(r) : res.json(r);
  } catch (e) { return next(e); }
});
router.get('/consent', adminsOrHr, async (req, res, next) => {
  try { res.json(await P.consentAging({ months: Number(req.query.months) || null })); } catch (e) { next(e); }
});
router.put('/consent', admins, async (req, res, next) => {
  try { const months = await P.setConsentMonths((req.body || {}).months); await logAudit({ userId: req.user.id, action: 'Consent review period changed', entity: 'AppSetting', entityId: 'privacy.consentMonths', toValue: `${months} months` }); res.json({ months }); } catch (e) { next(e); }
});

module.exports = router;
