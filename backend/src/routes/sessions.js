// ---------------------------------------------------------------------------
// SIGNED-IN DEVICES + IDLE TIMEOUT routes, mounted by routes/auth.js at /api/auth (utils/sessions.js has the story).
//   POST /logout                              this device signs out (kept in the history as "signed out")
//   GET  /sessions                            my devices and the last 30 days
//   POST /sessions/:sid/end                   sign one of my devices out
//   POST /sessions/end-others                 sign out every device but this one
//   GET  /sessions/user/:userId               (Super Admin / Admin) anybody's devices
//   POST /sessions/user/:userId/:sid/end      (Super Admin / Admin) sign that device out
//   GET  /security/idle | PUT /security/idle { minutes }   (PUT: Super Admin / Admin; 0 = off)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const S = require('../utils/sessions');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { scopeOf } = require('../utils/scope');

const rolesOf = (u) => [u && u.role, u && u.hrmsRole, u && u.atsRole, u && u.accountsRole].filter(Boolean);
const isSuper = (u) => rolesOf(u).includes('SUPER_ADMIN');
const isAdmin = (u) => isSuper(u) || rolesOf(u).includes('ADMIN') || !!scopeOf(u).adminGlobal;

const router = express.Router();
router.use(['/logout', '/sessions', '/security'], requireAuth);
const sidOf = (req) => req.sessionId || null;

router.post('/logout', async (req, res, next) => {
  try {
    if (sidOf(req) && !req.viewAs) {
      await S.end(sidOf(req), 'signed out', req.user.id);
      await logAudit({ userId: req.user.id, action: 'Signed out', entity: 'User', entityId: req.user.id });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/sessions', async (req, res, next) => {
  try { res.json({ sessions: await S.listOf(req.user.id, sidOf(req)), idleMinutes: await S.idleMinutes() }); } catch (e) { next(e); }
});

router.post('/sessions/end-others', async (req, res, next) => {
  try {
    if (req.viewAs) return res.status(403).json({ error: 'Not in View as.' });
    const n = await S.endAllOf(req.user.id, 'signed out from another device', { except: sidOf(req), by: req.user.id });
    await logAudit({ userId: req.user.id, action: 'Signed out all other devices', entity: 'User', entityId: req.user.id, toValue: `${n} device(s)` });
    return res.json({ ended: n });
  } catch (e) { return next(e); }
});

router.post('/sessions/:sid/end', async (req, res, next) => {
  try {
    if (req.viewAs) return res.status(403).json({ error: 'Not in View as.' });
    const row = await S.get(req.params.sid);
    if (!row || row.userId !== req.user.id) return res.status(404).json({ error: 'That device is not one of yours.' });
    await S.end(row.id, row.id === sidOf(req) ? 'signed out' : 'signed out from another device', req.user.id);
    await logAudit({ userId: req.user.id, action: 'Signed a device out', entity: 'User', entityId: req.user.id, toValue: S.deviceOf(row.userAgent) });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
});

const adminOnly = (req, res, nxt) => (isAdmin(req.user) && !req.viewAs ? nxt() : res.status(403).json({ error: 'Only a Super Admin or an Admin can do this.' }));
router.get('/sessions/user/:userId', adminOnly, async (req, res, next) => {
  try { res.json({ sessions: await S.listOf(req.params.userId) }); } catch (e) { next(e); }
});
router.post('/sessions/user/:userId/:sid/end', adminOnly, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, name: true, role: true, hrmsRole: true, atsRole: true, accountsRole: true } });
    if (!target) return res.status(404).json({ error: 'That login is not there.' });
    if (isSuper(target) && !isSuper(req.user)) return res.status(403).json({ error: 'Only a Super Admin can sign out a Super Admin.' });
    const row = await S.get(req.params.sid);
    if (!row || row.userId !== target.id) return res.status(404).json({ error: 'That device is not this login\'s.' });
    await S.end(row.id, 'admin', req.user.id);
    await logAudit({ userId: req.user.id, action: 'Device signed out by an administrator', entity: 'User', entityId: target.id, toValue: `${target.name} · ${S.deviceOf(row.userAgent)}` });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
});

router.get('/security/idle', async (req, res, next) => {
  try { res.json({ minutes: await S.idleMinutes(), canManage: isAdmin(req.user) }); } catch (e) { next(e); }
});
router.put('/security/idle', adminOnly, async (req, res, next) => {
  try {
    const before = await S.idleMinutes();
    const minutes = await S.setIdleMinutes((req.body || {}).minutes);
    await logAudit({ userId: req.user.id, action: 'Idle sign-out changed', entity: 'AppSetting', entityId: 'security.idleMinutes', fromValue: before ? `${before} min` : 'off', toValue: minutes ? `${minutes} min` : 'off' });
    res.json({ minutes });
  } catch (e) { next(e); }
});

module.exports = router;
