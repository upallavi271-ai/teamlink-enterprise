const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveIdentity, tokenPayload } = require('../utils/identity');
const { effectiveMatrix, allowedStagesFor, STAGE_WORKFLOW_ACTIONS } = require('../utils/permissions');
const { departmentsOf, scopeOf, hrmsGlobal, scopeLabel } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const passwordReset = require('../utils/passwordReset');
const { ipOf } = require('../utils/clientIp');
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
  if (passwordStatus) {
    delete passwordStatus.failedLoginCount; delete passwordStatus.resetLinkExpiresAt;
    // true = "Change your password now" screen before anything else (utils/seedPasswords.js).
    passwordStatus.mustChange = await require('../utils/seedPasswords').mustChange(identity.id); // eslint-disable-line global-require
  }
  return {
    ...identity,
    access,
    passwordStatus,
    workflow: { allowedStages, stageActions: STAGE_WORKFLOW_ACTIONS, bdeTl: require('../utils/scope').isBdeTl(identity) }, // eslint-disable-line global-require
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

// ---------------------------------------------------------------------------
// SIGN-IN (rewritten 2026-10-21 for SEPARATE LOGINS ON ONE EMAIL; utils/loginAccounts.js has the story).
//
//   The page sends the EMAIL and the password (the founder's decision, 2026-10-21: email only, no Login ID anywhere). What it means:
//     * an email with ONE account  -> exactly what this route always did (every existing login signs in as before).
//     * an email with SEVERAL accounts -> the email alone cannot say which one is meant, so the password is checked against EACH of them
//       (the same work whatever the answer), and:
//          - one account matches -> it signs in;
//          - several match (the same password was set on more than one) -> "Choose your account": a list of role + department only and a
//            signed, single-use, 5-minute choice token (POST /login/choose). No names, phones or other emails are ever listed;
//          - none match -> the same plain "wrong login or password" as for an email nobody has.
//   Wrong-password counters and locks belong to ONE account. A wrong try on the shared email does not touch any account (otherwise one
//   person's typo would lock their sibling logins); it only counts against the typed text (10 tries / 15 minutes, then wait).
// ---------------------------------------------------------------------------
const LA = require('../utils/loginAccounts');

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
const wrongText = () => 'Invalid email or password';

const typedFails = new Map(); // typed text -> [timestamps]
const TYPED_MAX = Number(process.env.LOGIN_TYPED_MAX || 10);
const TYPED_WINDOW = 15 * 60 * 1000;
function typedRecent(key) {
  const now = Date.now();
  const list = (typedFails.get(key) || []).filter((t) => now - t < TYPED_WINDOW);
  typedFails.set(key, list);
  return list;
}
const typedBlocked = (key) => typedRecent(key).length >= TYPED_MAX;
// A right password (the owner of one of the logins) clears the wrong tries counted against the typed email.
const typedClear = (key) => { typedFails.delete(key); };
function typedFail(key) {
  typedRecent(key).push(Date.now());
  if (typedFails.size > 5000) typedFails.clear();
}

// Every sign-in does at least two password comparisons, whatever it finds, so the time taken says little about the answer.
async function spend(password, done) {
  for (let i = done; i < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await bcrypt.compare(password, DUMMY_HASH);
  }
}

// Everything after "the password is right" - one place for the plain sign-in and the "Choose your account" step.
async function finishSignIn(req, res, user) {
  // A login an admin has disabled on the Users screen is really disabled.
  if (user.status && user.status !== 'Active') {
    if (user.status === 'Locked') return res.status(403).json({ error: 'This login is locked by HR. Ask HR to unlock it.' });
    return res.status(403).json({ error: `This login is ${user.status.toLowerCase()} — ask an administrator to re-enable it` });
  }

  const identity = await resolveIdentity(user.id, user);
  if (!identity.products.hrms && !identity.products.ats && !identity.products.accounts
      && !['CLIENT', 'CANDIDATE'].includes(identity.role)) {
    // No product names: this is a login screen, and the message is read
    // before we know anything about who is reading it.
    return res.status(403).json({ error: 'This login has no access yet — ask an administrator to grant it' });
  }

  // A person who has left (Exited / Relieved) cannot sign in (utils/leftLogin.js).
  if (require('../utils/leftLogin').hasLeft(identity)) { // eslint-disable-line global-require
    await logAudit({ userId: user.id, action: 'Sign-in refused (employment ended)', entity: 'User', entityId: user.id, toValue: identity.employmentStatus, reason: `IP ${ipOf(req)}` });
    return res.status(403).json({ error: require('../utils/leftLogin').MESSAGE, code: 'EMPLOYMENT_ENDED' }); // eslint-disable-line global-require
  }

  // Stamps the Users screen's "Last Login" column, and clears the failed
  // sign-in counter.
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } });

  await logAudit({ userId: user.id, action: 'Signed in', entity: 'User', entityId: user.id, reason: `IP ${ipOf(req)}` });
  // tms = the exact millisecond, so "sign this login out" (utils/loginAccounts.js revokeSessions) can tell an old token from a new one.
  const token = jwt.sign({ ...tokenPayload(identity), tms: Date.now() }, process.env.JWT_SECRET, { expiresIn: '8h' });
  return res.json({ token, user: await sessionPayload(identity) });
}

const lockedBody = (until) => ({
  error: `This login is locked after too many failed sign-ins. Try again after ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, or ask HR to reset your password.`,
});

// The whole login chain, in order:
//   identify the account(s) -> check the password -> load Employee / Client /
//   Candidate record -> load product access -> load role -> load
//   department/team/scope -> determine landing page.
// No role is ever asked for: it is derived from the employee's designation.
router.post('/login', async (req, res) => {
  const body = req.body || {};
  const typed = body.email;
  const { password } = body;
  if (!typed || !password) return res.status(400).json({ error: 'Email and password are required' });
  const pw = String(password);

  const got = await LA.resolveIdentifier(typed);
  const { accounts } = got;
  const key = got.identifier;
  // THE ONE LOGIN PAGE (frontend Login.jsx) asks this staff sign-in FIRST and only on a plain 401 asks the vendor sign-in. When a VENDOR login
  // uses the same email (founder, 2026-10-21: allowed), a vendor typing the vendor password must not count as a wrong try against any staff
  // account, so with a vendor on the email the password is checked against EVERY account on it and no staff counter is ever touched.
  let vendorRow = null;
  try {
    const VC = require('../utils/vendorConfig'); // eslint-disable-line global-require
    const vid = VC.loginIdOf(typed);
    vendorRow = vid ? await prisma.vendorUser.findUnique({ where: { email: vid }, include: { vendor: true } }) : null;
    if (vendorRow && vendorRow.deletedAt) vendorRow = null;
  } catch { vendorRow = null; }
  // Unknown text, or an email shared by several logins: counted against the typed text (a single account has its own lock below).
  if ((accounts.length !== 1 || vendorRow) && typedBlocked(key)) {
    // With a vendor on the email the answer stays a plain 401 (the page then asks the vendor sign-in, which has its own lock): a 429 would hide it.
    if (vendorRow) { await spend(pw, 0); return res.status(401).json({ error: wrongText() }); }
    return res.status(429).json({ error: 'Too many wrong tries. Please wait a few minutes and try again.', code: 'TOO_MANY' });
  }

  if (accounts.length === 0 && !vendorRow) {
    await spend(pw, 0);
    typedFail(key);
    // SECURITY (2026-10-13): failed sign-ins are audited (address typed + IP; never the password).
    await logAudit({ action: 'Failed sign-in (no such login)', entity: 'User', toValue: String(typed).trim().slice(0, 120), reason: `IP ${ipOf(req)}` });
    return res.status(401).json({ error: wrongText() });
  }

  if (accounts.length === 1 && !vendorRow) {
    const user = accounts[0];
    // LOCKOUT (hrms-24 §12). A locked login is refused before the password is
    // even compared, so guessing during the lock learns nothing.
    if (isLocked(user)) return res.status(423).json(lockedBody(user.lockedUntil));
    const ok = await bcrypt.compare(pw, user.passwordHash);
    await spend(pw, 1);
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
      await logAudit({ userId: user.id, action: 'Failed sign-in (wrong password)', entity: 'User', entityId: user.id, toValue: `Attempt ${failed}`, reason: `IP ${ipOf(req)}` });
      return res.status(401).json({ error: wrongText() });
    }
    return finishSignIn(req, res, user);
  }

  // Several logins share this email (or a vendor login does too). Check the password against each unlocked one (a locked one still costs the
  // same time). With a vendor on the email a locked staff login is compared for real too, so a holder of its password is told it is locked.
  const open = accounts.filter((u) => !isLocked(u));
  if (!open.length && !vendorRow) {
    await spend(pw, 0);
    const until = accounts.map((u) => new Date(u.lockedUntil).getTime()).sort((a, b) => a - b)[0];
    return res.status(423).json(lockedBody(until));
  }
  const matched = [];
  let lockedMatch = 0;
  for (const u of accounts) {
    const skip = isLocked(u) && !vendorRow;
    // eslint-disable-next-line no-await-in-loop
    const same = await bcrypt.compare(pw, skip ? DUMMY_HASH : u.passwordHash);
    if (same && !skip) { if (isLocked(u)) lockedMatch += 1; else matched.push(u); }
  }
  let vendorMatch = false;
  let vendorChecks = 0;
  if (vendorRow) {
    const VC = require('../utils/vendorConfig'); // eslint-disable-line global-require
    for (const p of VC.passwordCandidates(pw, { temp: !!vendorRow.mustChangePassword })) {
      vendorChecks += 1;
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(p, vendorRow.passwordHash)) { vendorMatch = true; break; }
    }
  }
  await spend(pw, accounts.length + vendorChecks);
  if (!matched.length && !lockedMatch && !vendorMatch) {
    typedFail(key);
    await logAudit({ action: 'Failed sign-in (wrong password, shared email)', entity: 'User', toValue: String(typed).trim().slice(0, 120), reason: `IP ${ipOf(req)}` });
    return res.status(401).json({ error: wrongText() });
  }
  const eligible = matched.filter((u) => !u.status || u.status === 'Active');
  if (!eligible.length && !vendorMatch) {
    if (lockedMatch) return res.status(423).json(lockedBody(accounts.map((u) => new Date(u.lockedUntil).getTime()).filter(Boolean).sort((a, b) => a - b)[0]));
    return res.status(403).json({ error: `This login is ${String(matched[0].status).toLowerCase()} — ask an administrator to re-enable it` });
  }
  // Only the VENDOR password matched: this is not a staff sign-in and not a wrong try. The plain 401 lets the page ask the vendor sign-in,
  // which says its own named reasons (locked, switched off, replaced by a newer email ...). Nothing is counted against any staff account.
  if (!eligible.length && vendorMatch) return res.status(401).json({ error: wrongText() });
  if (eligible.length === 1 && !vendorMatch) { typedClear(key); return finishSignIn(req, res, eligible[0]); }
  typedClear(key);

  // The same password opens more than one login: the person says which one they mean.
  // Shown as role + department only (two that read the same are told apart as "Login 1" / "Login 2", oldest first). No names, phones or emails.
  // A vendor login on the same email appears as "Vendor - <company>"; picking it hands over to the vendor sign-in.
  const sums = await LA.summariesFor(eligible);
  const entries = eligible.map((u, i) => ({ id: u.id, passwordHash: u.passwordHash, label: vendorMatch ? `Staff - ${sums[i].label}` : sums[i].label }));
  if (vendorMatch) entries.push({ id: `v:${vendorRow.id}`, passwordHash: vendorRow.passwordHash, label: `Vendor - ${(vendorRow.vendor && vendorRow.vendor.name) || 'vendor'}` });
  const sel = LA.makeSelectionToken(entries, req, key);
  await logAudit({ action: 'Sign-in: asked which login to open', entity: 'User', toValue: `${entries.length} logins`, reason: `IP ${ipOf(req)}` });
  return res.json({
    chooseAccount: true,
    selectionToken: sel.token,
    expiresAt: sel.expiresAt,
    accounts: entries.map((e, i) => ({ choice: String(i), label: e.label })),
  });
});

// Step 2 of "Choose your account": the signed token proves the password, the person names which one in the list (choice = its position).
router.post('/login/choose', async (req, res) => {
  const { selectionToken, choice } = req.body || {};
  const refuse = (code) => res.status(401).json({
    error: code === 'expired' ? 'That took too long. Please sign in again.' : 'That choice is no longer valid. Please sign in again.',
    code: code === 'expired' ? 'CHOICE_EXPIRED' : 'CHOICE_INVALID',
  });
  const out = await LA.redeemSelectionToken(selectionToken, choice, req);
  if (!out.ok) return refuse(out.code);
  // A vendor login on the same email was picked: the page signs the vendor in through the vendor sign-in (its own checks and messages).
  if (String(out.userId).startsWith('v:')) {
    const vu = await prisma.vendorUser.findUnique({ where: { id: String(out.userId).slice(2) } }).catch(() => null);
    if (!vu || LA.fingerprint(vu.passwordHash) !== out.fp) return refuse('invalid');
    return res.json({ useVendor: true });
  }
  const user = (await LA.usersByIds([out.userId]))[0];
  // The password may have changed in the meantime (a reset): then the choice is void.
  if (!user || LA.fingerprint(user.passwordHash) !== out.fp) return refuse('invalid');
  if (isLocked(user)) return res.status(423).json(lockedBody(user.lockedUntil));
  return finishSignIn(req, res, user);
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
  // Super Admin "Act as" (utils/actAs.js): same slot, editable. The screens
  // that hide admin-only items while `viewAs` is set keep doing so.
  if (req.actingAs) {
    payload.viewAs = { byName: req.actingAs.byName, readOnly: false, mode: 'act', expiresAt: req.actingAs.expiresAt };
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
  await logAudit({
    userId: user.id, action: 'Password changed (self-service)', entity: 'User', entityId: user.id, toValue: 'Changed',
    reason: `IP ${ipOf(req)}`,
  });
  // Ends older sessions, kills any live reset link and tells Super Admin / Admin
  // THAT it changed (never what it is). The person keeps THIS session: a fresh
  // token is handed back for the browser to store.
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  require('../utils/seedPasswords').forget(user.id); // eslint-disable-line global-require
  await passwordReset.afterPasswordChange({ user: fresh, method: 'my_profile' });
  const identity = await resolveIdentity(user.id, fresh);
  return { status: 200, token: identity ? jwt.sign({ ...tokenPayload(identity), tms: Date.now() }, process.env.JWT_SECRET, { expiresIn: '8h' }) : null };
}

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    return res.status(400).json({ field: 'confirmPassword', error: 'The two new passwords do not match.' });
  }
  const out = await changeOwnPassword(req, currentPassword, newPassword);
  if (out.status !== 200) return res.status(out.status).json({ field: out.field, error: out.error });
  return res.json({ ok: true, message: 'Password changed. Sign in again with your new password.', token: out.token || undefined });
});

// ---- FORGOT PASSWORD (public: the person cannot sign in) -----------------------
// utils/passwordReset.js has the whole story. The three promises kept here:
//  * ONE answer for any e-mail typed (real or not), at the same speed - the mail
//    is built and sent AFTER the answer has gone out;
//  * only "e-mail is not connected" (the same for every address) is said out loud;
//  * the reset page and link live at /new-password (not /reset-password: that
//    path belongs to the Job Portal).
router.post('/forgot-password', async (req, res) => {
  // An email (utils/passwordReset.js: what happens when several logins share it).
  const email = passwordReset.normEmail(req.body && req.body.email);
  const stop = await passwordReset.screenRequest(req, email);
  if (stop) {
    if (stop.headers) res.set(stop.headers);
    return res.status(stop.status).json(stop.body);
  }
  res.json({ ok: true, message: passwordReset.NEUTRAL_MESSAGE });
  return setImmediate(() => passwordReset.processRequest(req, email));
});

router.get('/reset-password/check', async (req, res) => {
  const out = await passwordReset.inspect(req, req.query.token);
  if (out.status !== 200) return res.status(out.status).json({ code: out.code, error: out.error });
  return res.json({ ok: true, expiresAt: out.expiresAt, minutesLeft: out.minutesLeft });
});

router.post('/reset-password', async (req, res) => {
  const { token, password, confirmPassword } = req.body || {};
  const out = await passwordReset.redeem(req, token, password, confirmPassword);
  if (out.status !== 200) return res.status(out.status).json({ code: out.code, error: out.error });
  return res.json({ ok: true, message: 'Your password is changed. Sign in with your new password.' });
});

// A hint, never a refusal: the new password is already the one of another login on this email.
router.post('/reset-password/same-check', async (req, res) => {
  const { token, password } = req.body || {};
  const got = await passwordReset.lookup(token);
  if (got.state !== 'ok') return res.status(410).json({ error: 'This link is not valid.' });
  return res.json({ sameAsOther: await LA.passwordUsedByOtherLogin(got.user, password) });
});

router.post('/reset-password/resend', async (req, res) => {
  const out = await passwordReset.resend(req, req.body && req.body.token);
  if (out.body && out.body.retryAfter) res.set('Retry-After', String(out.body.retryAfter));
  return res.status(out.status).json(out.body);
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
