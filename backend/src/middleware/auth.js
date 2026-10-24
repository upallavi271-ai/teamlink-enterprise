const jwt = require('jsonwebtoken');
const { resolveIdentity } = require('../utils/identity');
const { can, requirePerm, requireProduct, DENIED } = require('../utils/permissions');
// Super Admin "View as" (read-only) — utils/viewAs.js.
const viewAs = require('../utils/viewAs');
const externalPortal = require('../utils/externalPortalAuth');

// Coarse capabilities derived from the permission matrix. These are NOT a
// second permission system: each one is a can() call, and every one of them
// used to be a hard-coded role list inside a route handler.
async function capsFor(identity) {
  const [hrmsManage, payrollManage, atsAct, atsOversight, accountsManage, clientDesk, billingDesk, candidateContact] = await Promise.all([
    can(identity, 'hrms', 'hrms', 'Employee Management', 'view'),
    // EDIT, NOT VIEW. This cap widens the payslip scope to a whole
    // department, so it has to mean "operates payroll" — an employee who may
    // read THEIR OWN payslip now holds the view, and reading it as `view`
    // would have handed every employee their department's salaries.
    can(identity, 'hrms', 'hrms', 'Payroll & Compensation', 'edit'),
    can(identity, 'ats', 'candidates', 'Pipeline Stages', 'edit'),
    can(identity, 'ats', 'recruiterbde', 'Team View', 'view'),
    can(identity, 'accounts', 'accounts', 'Invoices', 'edit'),
    // Full client records (contacts, address, GSTIN, agreement, commercial
    // terms) — the client desk and the billing desk. Since the clients role
    // spec (2026-09-29) a TL may OPEN a client (Client List view) but never
    // its commercial terms or contact details, so this reads Commercial
    // Terms / view; utils/clientRedact.js decides the per-role level.
    can(identity, 'ats', 'clients', 'Commercial Terms', 'view'),
    can(identity, 'accounts', 'accounts', 'Invoices', 'view'),
    // The Role Catalog switch "Candidate contact and salary" (separate from
    // viewing the candidate): utils/clientRedact.js cuts email / phone /
    // salary for a login without it. The BDE team never holds it (their cut is
    // also applied by role in clientRedact.privacyFlagsFor).
    can(identity, 'ats', 'candidates', 'Candidate Contact & Salary', 'view'),
  ]);
  return {
    hrmsManage,
    // "Sees only their own HRMS records" — the old `role === 'EMPLOYEE'` test.
    hrmsSelfOnly: !hrmsManage,
    payrollManage,
    atsAct,
    atsOversight,
    accountsManage,
    clientDetail: clientDesk || billingDesk,
    candidateContact,
    // Role Catalog switch "Contact (Mail / WhatsApp / SMS / Call)" (utils/contactAccess.js).
    contact: await require('../utils/contactAccess').switchOn(identity).catch(() => false), // eslint-disable-line global-require
  };
}

// requireAuth verifies the token and then RE-RESOLVES the identity from the
// database on every request, so that disabling a login, removing a product or
// changing a designation takes effect on the next call rather than when the
// eight-hour token expires. The token is the credential; the database is the
// source of truth.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const identity = await resolveIdentity(claims.id);
    if (!identity) return res.status(401).json({ error: 'Invalid or expired token' });
    // A sign-in older than the last password change is over (utils/passwordReset.js).
    // Without this a reset would not log out someone who already holds a session.
    if (await require('../utils/passwordReset').tokenIsStale(claims)) { // eslint-disable-line global-require
      return res.status(401).json({ error: 'Your password was changed. Please sign in again.', code: 'PASSWORD_CHANGED' });
    }
    // "Sign this login out" by an Admin (utils/loginAccounts.js): ends this ONE account's older sessions, never a sibling's.
    if (await require('../utils/loginAccounts').tokenIsRevoked(claims)) { // eslint-disable-line global-require
      return res.status(401).json({ error: 'This login was signed out by an administrator. Please sign in again.', code: 'LOGIN_REVOKED' });
    }
    // A person who has left is signed out on their next request (utils/leftLogin.js).
    if (require('../utils/leftLogin').hasLeft(identity)) return res.status(401).json({ error: require('../utils/leftLogin').MESSAGE, code: 'EMPLOYMENT_ENDED' }); // eslint-disable-line global-require
    if (identity.status && identity.status !== 'Active') {
      return res.status(403).json({ error: `This login is ${identity.status.toLowerCase()}` });
    }
    // CLIENT / CANDIDATE PORTAL WALL, second layer (utils/externalPortalAuth.js):
    // judged on the identity read from the database, so an older token cannot
    // keep staff reach after a role change.
    if (!externalPortal.identityAllowed(identity, req)) return externalPortal.denyIdentity(req, res, identity);
    // VIEW AS: req.user is the TARGET, so every permission and scope rule
    // applies exactly as it does for that person; req.viewAs says who is
    // really looking. Writes are refused by viewAs.viewAsGuard (index.js).
    if (claims.viewAs) {
      const refused = await viewAs.checkSession(claims, identity);
      if (refused) return res.status(refused.status).json(refused.body);
      req.viewAs = {
        byUserId: claims.viewAs.byUserId, byName: claims.viewAs.byName, readOnly: true, sid: claims.viewAs.sid,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      };
      viewAs.enterContext(claims.viewAs);
    }
    // ACT AS (utils/actAs.js): req.user is the TARGET with exactly their own
    // rights; req.actingAs says who is really at the keyboard. req.viewAs stays
    // unset — nothing treats these requests as read-only. The hard-blocked
    // list, send confirmations and audit rows are in actAs.guard (index.js,
    // through viewAs.viewAsGuard).
    if (claims.actAs && !claims.viewAs) {
      const actAs = require('../utils/actAs'); // eslint-disable-line global-require
      const refused = await actAs.checkSession(claims, identity);
      if (refused) return res.status(refused.status).json(refused.body);
      req.actingAs = {
        byUserId: claims.actAs.byUserId, byName: claims.actAs.byName, mode: 'act', sid: claims.actAs.sid,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      };
      actAs.enterContext(req);
    }
    // A handful of coarse capabilities, resolved from the SAME engine, so the
    // dozens of "is this an employee?" data-scoping branches inside handlers
    // can stay synchronous without reintroducing role checks.
    // STARTING PASSWORD (security fix 2026-10-13): a login that never changed its seed / demo password may call only
    // /api/auth/* (to see its status and change the password) until it has chosen its own. See utils/seedPasswords.js.
    if (!claims.viewAs && !claims.actAs && !/^\/api\/auth(\/|\?|$)/.test(String(req.originalUrl || req.url || ''))) {
      if (await require('../utils/seedPasswords').mustChange(identity.id)) { // eslint-disable-line global-require
        return res.status(403).json({ error: 'Change your password now. This account still uses a starting password.', code: 'PASSWORD_CHANGE_REQUIRED' });
      }
    }
    // INTERNAL HR (utils/internalHr.js): sees every employee on the attendance / leave / directory
    // requests only; every other request keeps the person's own scope.
    if (identity.internalHr) require('../utils/internalHr').setScopeFor(identity.internalHr, req); // eslint-disable-line global-require
    identity.caps = await capsFor(identity);
    req.user = identity;
    // HR SUPER ACCESS (utils/hrSuper.js): the guards kept Super-Admin-only, and the delete / export / import alerts.
    if (identity.hrSuper) {
      const hrSuper = require('../utils/hrSuper'); // eslint-disable-line global-require
      const refused = await hrSuper.checkRequest(req, identity);
      if (refused) return res.status(refused.status).json({ error: refused.error, hrSuperGuard: refused.guard });
      require('../utils/hrSensitiveAlert').watch(req, res); // eslint-disable-line global-require
    }
    // HR WATCH (utils/hrWatch.js): a request by a watched person is reported to their team lead when it finishes.
    try {
      const hrWatch = require('../utils/hrWatch'); // eslint-disable-line global-require
      if (await hrWatch.lookup(identity.id)) hrWatch.enter(req, res);
    } catch { /* a watch problem never blocks a request */ }
    return next();
  } catch (err) {
    return next(err);
  }
}

// NOTE: requireRole() is gone. There is exactly one permission system now —
// utils/permissions.js — and every former requireRole(...) site went through
// requirePerm(product, module, feature, action). Data scope lives in
// utils/scope.js and is applied by the list and record endpoints themselves.
module.exports = { requireAuth, requirePerm, requireProduct, can, DENIED };
