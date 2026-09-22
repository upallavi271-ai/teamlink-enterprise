const jwt = require('jsonwebtoken');
const { resolveIdentity } = require('../utils/identity');
const { can, requirePerm, requireProduct, DENIED } = require('../utils/permissions');

// Coarse capabilities derived from the permission matrix. These are NOT a
// second permission system: each one is a can() call, and every one of them
// used to be a hard-coded role list inside a route handler.
async function capsFor(identity) {
  const [hrmsManage, payrollManage, atsAct, atsOversight, accountsManage] = await Promise.all([
    can(identity, 'hrms', 'hrms', 'Employee Management', 'view'),
    // EDIT, NOT VIEW. This cap widens the payslip scope to a whole
    // department, so it has to mean "operates payroll" — an employee who may
    // read THEIR OWN payslip now holds the view, and reading it as `view`
    // would have handed every employee their department's salaries.
    can(identity, 'hrms', 'hrms', 'Payroll & Compensation', 'edit'),
    can(identity, 'ats', 'candidates', 'Pipeline Stages', 'edit'),
    can(identity, 'ats', 'recruiterbde', 'Team View', 'view'),
    can(identity, 'accounts', 'accounts', 'Invoices', 'edit'),
  ]);
  return {
    hrmsManage,
    // "Sees only their own HRMS records" — the old `role === 'EMPLOYEE'` test.
    hrmsSelfOnly: !hrmsManage,
    payrollManage,
    atsAct,
    atsOversight,
    accountsManage,
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
    if (identity.status && identity.status !== 'Active') {
      return res.status(403).json({ error: `This login is ${identity.status.toLowerCase()}` });
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
