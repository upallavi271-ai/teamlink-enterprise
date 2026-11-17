// ---------------------------------------------------------------------------
// TWO-STEP SIGN-IN routes, mounted by routes/auth.js at /api/auth/mfa (utils/mfa.js has the story).
//
//   At sign-in (no session yet; the 5-minute ticket from POST /api/auth/login proves the password):
//     POST /verify          { mfaTicket, code | recoveryCode }  -> the normal { token, user }
//     POST /enrol/start     { mfaTicket }                       -> { secret, otpauth, qrSvg }   (company rule: set it up now)
//     POST /enrol/confirm   { mfaTicket, code }                 -> { token, user, recoveryCodes }
//   Signed in:
//     GET  /status                                   -> { enabled, enabledAt, recoveryLeft, required, canManage }
//     POST /start    { password }                    -> { secret, otpauth, qrSvg }
//     POST /confirm  { code }                        -> { recoveryCodes }
//     POST /disable  { password, code }
//     POST /recovery { code }                        -> { recoveryCodes } (new set; the old ones stop working)
//   Super Admin / Admin:
//     GET  /policy  | PUT /policy { roles: [...] }   compulsory for these roles
//     GET  /enabled                                  -> { userIds } (the Users screen marks them)
//     POST /reset/:userId                            lost phone: clears it, signs that login out everywhere
// Wrong codes count on the SAME lock as wrong passwords (5 tries, then locked). Every step is audited, never the code itself.
// ---------------------------------------------------------------------------
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const MFA = require('../utils/mfa');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { ipOf } = require('../utils/clientIp');
const { isLocked, MAX_FAILED_LOGINS, LOCK_MINUTES } = require('../utils/passwordPolicy');
const { scopeOf } = require('../utils/scope');

const rolesOf = (u) => [u && u.role, u && u.hrmsRole, u && u.atsRole, u && u.accountsRole].filter(Boolean);
const isSuper = (u) => rolesOf(u).includes('SUPER_ADMIN');
const isAdmin = (u) => isSuper(u) || rolesOf(u).includes('ADMIN') || !!scopeOf(u).adminGlobal;
const lockedBody = (until) => ({ error: `This login is locked after too many wrong tries. Try again after ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.` });

module.exports = function mfaRouter({ finishSignIn }) {
  const router = express.Router();

  // the user behind a ticket, only while the password is the one that was typed
  async function ticketUser(ticket, purpose) {
    const c = MFA.readTicket(ticket, purpose);
    if (!c) return null;
    const user = await prisma.user.findUnique({ where: { id: c.u } });
    if (!user || MFA.fp(user.passwordHash) !== c.f) return null;
    return user;
  }
  const expired = (res) => res.status(401).json({ error: 'That took too long. Please sign in again.', code: 'MFA_TICKET_EXPIRED' });
  async function wrongTry(req, user, what) {
    const failed = (user.failedLoginCount || 0) + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await prisma.user.update({ where: { id: user.id }, data: lock ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedLoginCount: failed } });
    if (lock) await logAudit({ userId: user.id, action: `Login locked after ${MAX_FAILED_LOGINS} failed sign-ins`, entity: 'User', entityId: user.id, toValue: `Locked ${LOCK_MINUTES} min` });
    await logAudit({ userId: user.id, action: `Failed sign-in (wrong ${what})`, entity: 'User', entityId: user.id, toValue: `Attempt ${failed}`, reason: `IP ${ipOf(req)}` });
  }

  // ---- at sign-in --------------------------------------------------------------------------------------
  router.post('/verify', async (req, res, next) => {
    try {
      const b = req.body || {};
      const user = await ticketUser(b.mfaTicket, 'verify');
      if (!user) return expired(res);
      if (isLocked(user)) return res.status(423).json(lockedBody(user.lockedUntil));
      const out = await MFA.check(user.id, { code: b.code, recoveryCode: b.recoveryCode });
      if (!out.ok) {
        await wrongTry(req, user, b.recoveryCode ? 'recovery code' : 'two-step code');
        return res.status(401).json({ error: out.error });
      }
      if (out.used === 'recovery') {
        await logAudit({ userId: user.id, action: 'Signed in with a recovery code', entity: 'User', entityId: user.id, toValue: `${out.recoveryLeft} left`, reason: `IP ${ipOf(req)}` });
      }
      return finishSignIn(req, res, user, { mfaPassed: true, extra: out.used === 'recovery' ? { recoveryLeft: out.recoveryLeft } : {} });
    } catch (e) { return next(e); }
  });

  router.post('/enrol/start', async (req, res, next) => {
    try {
      const user = await ticketUser((req.body || {}).mfaTicket, 'enrol');
      if (!user) return expired(res);
      return res.json(await MFA.start(user.id, user.email || user.name));
    } catch (e) { return next(e); }
  });

  router.post('/enrol/confirm', async (req, res, next) => {
    try {
      const b = req.body || {};
      const user = await ticketUser(b.mfaTicket, 'enrol');
      if (!user) return expired(res);
      if (isLocked(user)) return res.status(423).json(lockedBody(user.lockedUntil));
      const out = await MFA.confirm(user.id, b.code);
      if (!out.ok) { await wrongTry(req, user, 'two-step code'); return res.status(400).json({ error: out.error }); }
      await logAudit({ userId: user.id, action: 'Two-step sign-in turned on (company rule, at sign-in)', entity: 'User', entityId: user.id, reason: `IP ${ipOf(req)}` });
      return finishSignIn(req, res, user, { mfaPassed: true, extra: { recoveryCodes: out.recoveryCodes } });
    } catch (e) { return next(e); }
  });

  // ---- signed in ---------------------------------------------------------------------------------------
  router.use(requireAuth);
  const ownOnly = (req, res) => {
    if (req.viewAs || (req.user && (req.user.actAs || req.user.viewAs))) { res.status(403).json({ error: 'Two-step sign-in is changed only by the person themselves, not in View as / Act as.' }); return false; }
    return true;
  };
  async function passwordOk(userId, password) {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    return !!row && !!password && bcrypt.compare(String(password), row.passwordHash);
  }

  router.get('/status', async (req, res, next) => {
    try {
      const s = await MFA.statusOf(req.user.id);
      res.json({ ...s, required: await MFA.requiredFor(req.user), canManage: isAdmin(req.user) });
    } catch (e) { next(e); }
  });

  router.post('/start', async (req, res, next) => {
    try {
      if (!ownOnly(req, res)) return undefined;
      if (!(await passwordOk(req.user.id, (req.body || {}).password))) return res.status(400).json({ error: 'Type your current password to start.' });
      return res.json(await MFA.start(req.user.id, req.user.email || req.user.name));
    } catch (e) { return next(e); }
  });

  router.post('/confirm', async (req, res, next) => {
    try {
      if (!ownOnly(req, res)) return undefined;
      const out = await MFA.confirm(req.user.id, (req.body || {}).code);
      if (!out.ok) return res.status(400).json({ error: out.error });
      await logAudit({ userId: req.user.id, action: 'Two-step sign-in turned on', entity: 'User', entityId: req.user.id, reason: `IP ${ipOf(req)}` });
      return res.json({ recoveryCodes: out.recoveryCodes });
    } catch (e) { return next(e); }
  });

  router.post('/disable', async (req, res, next) => {
    try {
      if (!ownOnly(req, res)) return undefined;
      const b = req.body || {};
      if (await MFA.requiredFor(req.user)) return res.status(409).json({ error: 'Two-step sign-in is compulsory for your role. If you lost your phone, ask an administrator to reset it.' });
      if (!(await passwordOk(req.user.id, b.password))) return res.status(400).json({ error: 'Your password is not right.' });
      const out = await MFA.check(req.user.id, { code: b.code, recoveryCode: b.recoveryCode });
      if (!out.ok) return res.status(400).json({ error: out.error });
      await MFA.turnOff(req.user.id);
      await logAudit({ userId: req.user.id, action: 'Two-step sign-in turned off', entity: 'User', entityId: req.user.id, reason: `IP ${ipOf(req)}` });
      return res.json({ ok: true });
    } catch (e) { return next(e); }
  });

  router.post('/recovery', async (req, res, next) => {
    try {
      if (!ownOnly(req, res)) return undefined;
      const out = await MFA.check(req.user.id, { code: (req.body || {}).code });
      if (!out.ok) return res.status(400).json({ error: out.error });
      const codes = await MFA.newRecovery(req.user.id);
      await logAudit({ userId: req.user.id, action: 'Two-step recovery codes replaced', entity: 'User', entityId: req.user.id });
      return res.json({ recoveryCodes: codes });
    } catch (e) { return next(e); }
  });

  // ---- administrators ----------------------------------------------------------------------------------
  const adminOnly = (req, res, nxt) => (isAdmin(req.user) && !req.viewAs ? nxt() : res.status(403).json({ error: 'Only a Super Admin or an Admin can do this.' }));

  router.get('/policy', adminOnly, async (req, res, next) => {
    try { res.json({ roles: await MFA.requiredRoles(), choices: MFA.POLICY_ROLES }); } catch (e) { next(e); }
  });
  router.put('/policy', adminOnly, async (req, res, next) => {
    try {
      const before = await MFA.requiredRoles();
      const roles = await MFA.setRequiredRoles((req.body || {}).roles);
      await logAudit({ userId: req.user.id, action: 'Two-step sign-in rule changed', entity: 'AppSetting', entityId: 'security.mfaRequiredRoles', fromValue: before.join(', ') || 'nobody', toValue: roles.join(', ') || 'nobody' });
      res.json({ roles });
    } catch (e) { next(e); }
  });
  router.get('/enabled', adminOnly, async (req, res, next) => {
    try {
      await MFA.ensure();
      const rows = await prisma.$queryRawUnsafe('SELECT "userId" FROM "UserMfa" WHERE "enabledAt" IS NOT NULL AND "secretEnc" IS NOT NULL');
      res.json({ userIds: rows.map((r) => r.userId) });
    } catch (e) { next(e); }
  });
  router.post('/reset/:userId', adminOnly, async (req, res, next) => {
    try {
      const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
      if (!target) return res.status(404).json({ error: 'That login is not there.' });
      if (isSuper(target) && !isSuper(req.user)) return res.status(403).json({ error: 'Only a Super Admin can reset a Super Admin\'s two-step sign-in.' });
      if (!(await MFA.isOn(target.id))) return res.status(409).json({ error: `${target.name} has not turned on two-step sign-in.` });
      await MFA.turnOff(target.id);
      await require('../utils/loginAccounts').revokeSessions(target.id).catch(() => {}); // eslint-disable-line global-require
      await logAudit({ userId: req.user.id, action: 'Two-step sign-in reset by an administrator', entity: 'User', entityId: target.id, toValue: target.name, reason: (req.body || {}).reason || 'Lost phone' });
      try {
        await require('../utils/notify').notifyUsers([target.id], { // eslint-disable-line global-require
          title: '🔐 Your two-step sign-in was reset',
          message: `${req.user.name} reset your two-step sign-in. Sign in with your password; set it up again on My Profile. If you did not ask for this, tell your administrator now.`,
        });
      } catch { /* the bell is a courtesy */ }
      return res.json({ ok: true });
    } catch (e) { return next(e); }
  });

  return router;
};
