const jwt = require('jsonwebtoken');
const { resolveIdentity } = require('../utils/identity');
const { can, requirePerm, requireProduct, DENIED } = require('../utils/permissions');
// Super Admin "View as" (read-only) — utils/viewAs.js.
const viewAs = require('../utils/viewAs');
// Sign-in sessions: server-side Sign Out and the 30-minute inactivity timeout
// HRMS shares with the Job Portal (utils/authSessions.js).
const authSessions = require('../utils/authSessions');

// Coarse capabilities derived from the permission matrix. These are NOT a
// second permission system: each one is a can() call, and every one of them
// used to be a hard-coded role list inside a route handler.
async function capsFor(identity) {
  const [hrmsManage, payrollManage, atsAct, atsOversight, accountsManage, clientDesk, billingDesk] = await Promise.all([
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
    // SIGN-IN SESSION. A token with a sid is only as good as its session:
    // signed out (here or in the Job Portal) or idle too long ends it.
    if (claims.sid && !claims.viewAs) {
      const s = await authSessions.checkAndTouch(claims.sid, authSessions.activityAt(req));
      if (!s.ok) {
        return res.status(401).json({
          error: s.reason === 'idle' ? 'Your session timed out after inactivity. Please sign in again.' : 'Your session has ended. Please sign in again.',
          code: 'SESSION_EXPIRED',
        });
      }
      req.authSid = claims.sid;
    }
    const identity = await resolveIdentity(claims.id);
    if (!identity) return res.status(401).json({ error: 'Invalid or expired token' });
    if (identity.status && identity.status !== 'Active') {
      return res.status(403).json({ error: `This login is ${identity.status.toLowerCase()}` });
    }
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
    // A handful of coarse capabilities, resolved from the SAME engine, so the
    // dozens of "is this an employee?" data-scoping branches inside handlers
    // can stay synchronous without reintroducing role checks.
    identity.caps = await capsFor(identity);
    req.user = identity;
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
