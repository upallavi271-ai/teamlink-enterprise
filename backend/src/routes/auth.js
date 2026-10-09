const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveIdentity, tokenPayload } = require('../utils/identity');
const { effectiveMatrix, allowedStagesFor, STAGE_WORKFLOW_ACTIONS } = require('../utils/permissions');
const { departmentsOf, scopeOf, hrmsGlobal, scopeLabel } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const authSessions = require('../utils/authSessions');
const jobPortalSso = require('../utils/jobPortalSso');
const {
  strengthError, passwordEventData, isLocked, passwordStatusOf, MAX_FAILED_LOGINS, LOCK_MINUTES,
} = require('../utils/passwordPolicy');

// Everything the browser needs to render this login: the identity, the
// EFFECTIVE permission matrix (every module resolved against ITS product's
// role — HRMS by hrmsRole, ATS by atsRole, Accounts by accountsRole, the core
// modules against every role the login holds) and the pipeline stages this
// login OWNS, which is the workflow half of §17 and is not implied by being
// able to see a record.
// The department names this login may choose from, or null when it is not
// restricted at all. The sentinel departmentsOf() returns for a scoped login
// with no department is mapped to an EMPTY list, not to null: "no departments"
// and "every department" must never collapse into each other.
function scopeDepartmentOptions(identity) {
  // HR IS COMPANY-WIDE IN HRMS. departmentsOf() is the ATS-shaped answer and
  // returns ['HR'] for the HR desk — the department they SIT in, not the one
  // they administer — which would have narrowed every HRMS dropdown to a
  // single wrong entry. utils/scope.js hrmsGlobal() is the same test
  // employeeWhere() uses to hand HR every employee.
  if (hrmsGlobal(identity)) return null;
  const allowed = departmentsOf(identity);
  if (allowed === undefined) return null;
  return allowed.filter((d) => d && !d.startsWith('__'));
}

async function sessionPayload(identity) {
  const [access, allowedStages] = await Promise.all([
    effectiveMatrix(identity),
    allowedStagesFor(identity),
  ]);
  // The login's own password status (hrms-24 §12) — flags and dates only.
  const pw = await prisma.user.findUnique({
    where: { id: identity.id },
    select: {
      passwordChangedAt: true, passwordResetRequired: true, failedLoginCount: true, lockedUntil: true,
      status: true, lastLoginAt: true, setPasswordTokenHash: true, setPasswordUsedAt: true, setPasswordExpiresAt: true,
    },
  }).catch(() => null);
  const passwordStatus = passwordStatusOf(pw);
  if (passwordStatus) { delete passwordStatus.failedLoginCount; delete passwordStatus.resetLinkExpiresAt; }
  return {
    ...identity,
    access,
    passwordStatus,
    // The sidebar's "Job Portal" item (single sign-on): Recruiter and Admin
    // only, and only once HRMS_SSO_SECRET is set (utils/jobPortalSso.js).
    jobPortal: jobPortalSso.accessFor(identity),
    workflow: { allowedStages, stageActions: STAGE_WORKFLOW_ACTIONS },
    // WHAT THIS LOGIN MAY FILTER BY, computed by utils/scope.js — the same
    // helper that decides what the lists actually return.
    //
    // Every department dropdown in the app was drawing from a HARD-CODED
    // DEPTS array in the browser, so a Medical TL opening Jobs / Requirements
    // was offered IT, Manufacturing, Education, BDE, HR and Accounts. The list
    // never widened what the server sent back, but naming other departments at
    // all is exactly what "vallaki option kuda visible avvakudadhu" rules out.
    //
    // `departments: null` means UNRESTRICTED (Super Admin / Admin), and the
    // browser then falls back to the full catalogue.
    scope: {
      // The §43 line every screen puts at the top — "Scope: My Team",
      // "Scope: Medical Department", "Scope: All Company". One computed
      // answer, so no two screens can word it differently.
      label: scopeLabel(identity),
      // Review #3 §27 — the ATS reading (HR = Internal Hiring, not All
      // Employees) for the header's scope indicator on ATS routes.
      atsLabel: scopeLabel(identity, 'ats'),
      departments: scopeDepartmentOptions(identity),
      teams: scopeOf(identity).teams && scopeOf(identity).teams.length ? scopeOf(identity).teams : null,
    },
  };
}

const router = express.Router();

// The whole login chain, in order:
//   validate email+password -> identify user -> load Employee / Client /
//   Candidate record -> load product access -> load role -> load
//   department/team/scope -> determine landing page.
// No role is ever asked for: it is derived from the employee's designation.
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } })
    || await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  // LOCKOUT (hrms-24 §12). A locked login is refused before the password is
  // even compared, so guessing during the lock learns nothing.
  if (isLocked(user)) {
    return res.status(423).json({
      error: `This login is locked after too many failed sign-ins. Try again after ${new Date(user.lockedUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, or ask HR to reset your password.`,
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const failed = (user.failedLoginCount || 0) + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: lock
        ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) }
        : { failedLoginCount: failed },
    });
    if (lock) {
      await logAudit({
        userId: user.id, action: `Login locked after ${MAX_FAILED_LOGINS} failed sign-ins`, entity: 'User', entityId: user.id,
        toValue: `Locked ${LOCK_MINUTES} min`,
      });
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // A login an admin has disabled on the Users screen is really disabled.
  if (user.status && user.status !== 'Active') {
    return res.status(403).json({ error: `This login is ${user.status.toLowerCase()} — ask an administrator to re-enable it` });
  }

  const identity = await resolveIdentity(user.id, user);
  if (!identity.products.hrms && !identity.products.ats && !identity.products.accounts
      && !['CLIENT', 'CANDIDATE'].includes(identity.role)) {
    // No product names: this is a login screen, and the message is read
    // before we know anything about who is reading it.
    return res.status(403).json({ error: 'This login has no access yet — ask an administrator to grant it' });
  }

  // Stamps the Users screen's "Last Login" column, and clears the failed
  // sign-in counter.
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } });

  // One AuthSession per sign-in: Sign Out ends it on the server, inactivity
  // ends it after SESSION_IDLE_MINUTES, and the Job Portal shares it.
  const sid = await authSessions.create(user.id);
  const token = jwt.sign({ ...tokenPayload(identity), sid }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: await sessionPayload(identity) });
});

// SIGN OUT, ON THE SERVER. Ends this sign-in's session (so the token is dead
// even if a copy survives) and the Job Portal sessions opened from it. An
// already-expired or unknown token is still answered 200: the browser drops
// it either way.
router.post('/logout', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  let claims = null;
  try { claims = token ? jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true }) : null; } catch { claims = null; }
  if (claims && claims.sid && !claims.viewAs) {
    await authSessions.revoke(claims.sid, 'signed out').catch(() => 0);
    await jobPortalSso.notifyPortalLogout(claims.sid);
  }
  res.json({ ok: true });
});

// Is this sign-in still alive? The browser asks once a minute (with how long
// the user has been idle, so the question itself is not activity) and goes to
// the login screen on a 401 — which is how signing out of the Job Portal, or
// the shared inactivity timeout, reaches an HRMS tab that is just sitting open.
router.get('/session', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, idleMinutes: Math.round(authSessions.idleMs() / 60000) });
});

// The resolved identity plus the permission matrix the frontend renders its
// nav and its action buttons from — the SAME matrix the server enforces.
router.get('/me', requireAuth, async (req, res) => {
  const payload = await sessionPayload(req.user);
  // Super Admin "View as" (utils/viewAs.js): the target's normal payload,
  // plus who is really looking and when the read-only session ends.
  if (req.viewAs) {
    payload.viewAs = { byName: req.viewAs.byName, readOnly: true, expiresAt: req.viewAs.expiresAt };
  }
  res.json(payload);
});

// SELF-SERVICE PASSWORD CHANGE (hrms-24 §12). The current password is always
// asked for — a session left open on a shared machine must not be enough to
// take the account over — then the strength rule, then bcrypt. The new hash
// is live immediately: the next sign-in uses it. The audit row records THAT
// it changed, never the value.
async function changeOwnPassword(req, currentPassword, newPassword) {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return { status: 404, error: 'Account not found' };
  if (isLocked(user)) return { status: 423, error: 'This login is locked after too many failed attempts. Try again later.' };
  if (!currentPassword || !newPassword) return { status: 400, error: 'Enter your current password and the new one.' };
  if (!(await bcrypt.compare(String(currentPassword), user.passwordHash))) {
    // Wrong current passwords count toward the same lockout as sign-in.
    const failed = (user.failedLoginCount || 0) + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: lock ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedLoginCount: failed },
    });
    await logAudit({ userId: user.id, action: 'Password change refused — wrong current password', entity: 'User', entityId: user.id });
    return { status: 400, field: 'currentPassword', error: 'Your current password is not correct.' };
  }
  const weak = strengthError(newPassword, { email: user.email, name: user.name });
  if (weak) return { status: 400, field: 'newPassword', error: weak };
  if (await bcrypt.compare(String(newPassword), user.passwordHash)) {
    return { status: 400, field: 'newPassword', error: 'Choose a password different from your current one.' };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(String(newPassword), 10),
      ...passwordEventData('self'),
      // A pending set-password link is a second way in; a new password burns it.
      setPasswordTokenHash: null, setPasswordExpiresAt: null,
    },
  });
  await logAudit({ userId: user.id, action: 'Password changed (self-service)', entity: 'User', entityId: user.id, toValue: 'Changed' });
  return { status: 200 };
}

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    return res.status(400).json({ field: 'confirmPassword', error: 'The two new passwords do not match.' });
  }
  const out = await changeOwnPassword(req, currentPassword, newPassword);
  if (out.status !== 200) return res.status(out.status).json({ field: out.field, error: out.error });
  return res.json({ ok: true, message: 'Password changed. Use the new password the next time you sign in.' });
});

router.put('/me', requireAuth, async (req, res) => {
  const { name, password, currentPassword } = req.body;
  const data = {};
  if (name) data.name = name;
  // A password change here goes through the same checks as /change-password;
  // it used to be hashed and saved with no current password at all.
  if (password) {
    const out = await changeOwnPassword(req, currentPassword, password);
    if (out.status !== 200) return res.status(out.status).json({ field: out.field, error: out.error });
  }
  if (Object.keys(data).length) await prisma.user.update({ where: { id: req.user.id }, data });
  const identity = await resolveIdentity(req.user.id);
  res.json(identity);
});

// Workspace switch for a login that carries several products. It records a
// preference — it never changes the user's role or permissions.
router.put('/me/workspace', requireAuth, async (req, res) => {
  const { workspace } = req.body;
  if (!['hrms', 'ats', 'accounts'].includes(workspace)) {
    return res.status(400).json({ error: 'Unknown workspace' });
  }
  if (!req.user.products[workspace]) {
    return res.status(403).json({ error: 'Your login does not include that product' });
  }
  await prisma.user.update({ where: { id: req.user.id }, data: { landingWorkspace: workspace } });
  const identity = await resolveIdentity(req.user.id);
  res.json(await sessionPayload(identity));
});

module.exports = router;
