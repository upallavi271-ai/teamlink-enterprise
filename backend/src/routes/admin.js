const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requirePerm, can: canPerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const passwordReset = require('../utils/passwordReset');
const { strengthError, passwordEventData, passwordStatusOf } = require('../utils/passwordPolicy');
const {
  ROLE_FEATURE_ACTIONS, ROLE_ACCESS_MODULES, CATALOG_ROLES, ROLE_SCOPE_DESC,
  PRODUCTS, PRODUCT_OF_MODULE, productKeyOf, NO_ROLE,
  moduleById, sanitizeFeatures, featureInfoOf,
} = require('../utils/roleAccess');
const {
  mergeAccess, invalidateRoleAccess, accessFor, viewOnlyLocksFor, hardLocksFor, clampHard,
} = require('../utils/permissions');
const {
  MATRIX_ROWS, MATRIX_ACTIONS, SCOPE_LEVELS, SCOPE_LEVEL_LABEL, SCOPE_ALIAS, BEHAVES_LIKE_ATS,
  cleanMatrix, productsOfMatrix, engineRowsFor, aiRowFor, matrixFromRole, listRoles, roleByCode, isKnownRole,
  isAssignableRole, newRoleCode, insertRole, updateRole, holdersOf,
} = require('../utils/roleRegistry');
const { scopeDepartments: scopeDepartmentsRaw, accountsGlobal } = require('../utils/scope');

// The department picker's scope. Same rule as everywhere else, with the one
// exception utils/scope.js already names: the Accounts desk runs payroll for
// every department, so an unconfigured accountant is offered all of them.
const scopeDepartments = (user) => (accountsGlobal(user) ? undefined : scopeDepartmentsRaw(user));

// The Role Catalog is Product → Module → Feature → Action now. A module's
// product is fixed (PRODUCT_OF_MODULE); what the product dimension buys is
// that the SAME role name can carry different access in ATS than in HRMS,
// because the row is stored per product. '*' rows are the pre-product rows
// and are merged UNDER any product-specific row, so nothing saved before
// this change loses effect.
const productOf = (moduleId) => productKeyOf(moduleId);

// 'NONE' is "no role in this product", never a role name to fall back from.
const named = (v) => (v && v !== NO_ROLE ? v : null);

// Find the pair of rows that decide one (role, module): the product-agnostic
// '*' row and the module's own product row.
function rowsFor(rows, role, moduleId) {
  const key = productOf(moduleId);
  const star = rows.find((r) => r.role === role && r.moduleId === moduleId && (r.product || '*') === '*');
  const specific = key === '*' ? null
    : rows.find((r) => r.role === role && r.moduleId === moduleId && r.product === key);
  return [star, specific];
}
const { invalidateDesignationMap, normaliseMapping } = require('../utils/identity');
const {
  ALL_ROLES, ATS_ROLES, productAccessOf, scopeLabelOf,
  designationRows, defaultProductAccessByRole,
  productRolesForDesignation, syncLoginToEmployee,
} = require('../utils/employeeAdmin');
const {
  INTEGRATION_CATALOG, INTEGRATION_GROUPS, SYNC_ENTITIES, ORG_STRUCTURE_DEFAULT,
  COMPANY_POLICIES, COMPANY_DEFAULTS, integrationById, LIVE_CHANNELS, JOB_BOARD_CHANNELS, SMS_FIELDS,
} = require('../utils/adminCatalog');
const { DEPTS, LOCS, REQUIREMENT_LIVE_STATUSES, requirementIsLive } = require('../utils/atsVocab');
const { publicValuesFor, writeValues, recordEvent, readConfig } = require('../utils/integrationStore');
const bio = require('../utils/biometricDevice');
const { secretsConfigured, ENV_VAR: SECRET_ENV_VAR, NO_KEY_MESSAGE } = require('../utils/secrets');
const mailer = require('../utils/mailer');
const mailWorker = require('../utils/mailWorker');
const aiAgent = require('../utils/aiAgent');
const { senderIdentity } = require('../utils/candidateComms');

const router = express.Router();
router.use(requireAuth);

// The role vocabulary, the Users product columns and the scope sentence are
// SHARED with the Employee Management surface in routes/employees.js. One
// definition, in utils/employeeAdmin.js — never a second copy here.

// ---- Users ----
//
// One employee = one user = one login. The prototype's Users screen (usersView,
// line 9893) shows fifteen columns per login and lets an admin change roles,
// suspend a login and reset a password inline.
//
// Product access is REAL now: hrmsAccess / atsAccess / accountsAccess are
// independent stored booleans, the ATS working role is derived from the
// employee's designation (and overridable per user), and the data scope is
// stored departments / teams / clients. There is never a second login for the
// same person, and the role is never chosen at sign-in.
const USER_STATUSES = ['Active', 'Inactive', 'Suspended'];

// designationRows() and defaultProductAccessByRole() are the same shared
// helpers (utils/employeeAdmin.js) the Add Employee form reads, so the Users
// screen and Employee Management can never disagree about what a
// designation grants.

// Normalises the product / role / scope half of a Users-screen payload.
// A product role must be a role on the registry (system or custom), and a
// newly GIVEN custom role must be Active. An inactive custom role a login
// already holds stays valid (it keeps working until reassigned).
async function productRoleError(body, existing = null) {
  const b = body || {};
  const pr = b.productRoles || {};
  const wanted = [['hrms', b.hrmsRole ?? pr.hrms], ['ats', b.atsRole ?? pr.ats], ['accounts', b.accountsRole ?? pr.accounts]];
  for (const [product, code] of wanted) {
    if (code === undefined || code === null || code === '' || code === NO_ROLE) continue;
    const held = existing && existing[`${product}Role`] === code;
    // eslint-disable-next-line no-await-in-loop
    if (!(held ? await isKnownRole(code) : await isAssignableRole(code))) {
      return `"${code}" is not an active role for ${product.toUpperCase()}.`;
    }
  }
  return null;
}

// The product-role fields a payload would write (same keys accessPatch reads), for the role guard.
function productRoleFields(body) {
  const d = accessPatch(body || {});
  const out = {};
  ['hrmsRole', 'atsRole', 'accountsRole'].forEach((k) => { if (d[k] !== undefined) out[k] = d[k]; });
  return out;
}

function accessPatch(body) {
  const data = {};
  const p = body.products || {};
  if (body.hrmsAccess !== undefined || p.hrms !== undefined) data.hrmsAccess = !!(body.hrmsAccess ?? p.hrms);
  if (body.atsAccess !== undefined || p.ats !== undefined) data.atsAccess = !!(body.atsAccess ?? p.ats);
  if (body.accountsAccess !== undefined || p.accounts !== undefined) data.accountsAccess = !!(body.accountsAccess ?? p.accounts);
  // THE THREE PRODUCT ROLES, each editable on its own. Clearing one is
  // 'NONE' — an explicit "no access to this product" — not null, which would
  // fall back to the account-level role.
  if (body.hrmsRole !== undefined) data.hrmsRole = body.hrmsRole || NO_ROLE;
  if (body.atsRole !== undefined) data.atsRole = body.atsRole || NO_ROLE;
  if (body.accountsRole !== undefined) data.accountsRole = body.accountsRole || NO_ROLE;
  const pr = body.productRoles || {};
  if (pr.hrms !== undefined) data.hrmsRole = pr.hrms || NO_ROLE;
  if (pr.ats !== undefined) data.atsRole = pr.ats || NO_ROLE;
  if (pr.accounts !== undefined) data.accountsRole = pr.accounts || NO_ROLE;
  if (body.atsScopeDepartments !== undefined) data.atsScopeDepartments = body.atsScopeDepartments || null;
  if (body.atsScopeTeams !== undefined) data.atsScopeTeams = body.atsScopeTeams || null;
  if (body.atsScopeClients !== undefined) data.atsScopeClients = body.atsScopeClients || null;
  if (body.landingWorkspace !== undefined) data.landingWorkspace = body.landingWorkspace || null;
  return data;
}

const LA = require('../utils/loginAccounts');
// Extra-login employee links and "how many logins on this email" for a set of users - two small queries, not one per row.
async function loginContext(users) {
  const out = { linked: new Map(), emailCounts: new Map() };
  try {
    await LA.ensure();
    const links = await LA.employeeIdsOfUsers(users.map((u) => u.id));
    const empIds = [...new Set([...links.values()])];
    const emps = empIds.length ? await prisma.employee.findMany({ where: { id: { in: empIds } } }) : [];
    const byId = new Map(emps.map((e) => [e.id, e]));
    links.forEach((eid, uid) => { if (byId.has(eid)) out.linked.set(uid, byId.get(eid)); });
    const counts = await LA.q('SELECT lower(trim("email")) AS e, COUNT(*) AS n FROM "User" GROUP BY lower(trim("email"))');
    counts.forEach((r) => out.emailCounts.set(r.e, r.n));
  } catch { /* the screen shows the logins without these extras */ }
  return out;
}

// The wide row the Users table renders: login + linked employee + reach.
async function shapeUser(user, ctx = null) {
  // SEPARATE LOGINS ON ONE EMAIL (2026-10-21): the Employee record an EXTRA login is linked to (utils/loginAccounts.js).
  const c = ctx || await loginContext([user]);
  const [assignedAsRecruiter, assignedAsBde] = await Promise.all([
    prisma.requirement.findMany({ where: { recruiterId: user.id }, include: { client: true } }),
    prisma.requirement.findMany({ where: { bdeId: user.id }, include: { client: true } }),
  ]);
  const requirements = [...assignedAsRecruiter, ...assignedAsBde];
  const linkedEmp = c.linked.get(user.id) || null;
  const emp = user.employee || linkedEmp;
  const clientNames = [...new Set(requirements.map((r) => r.client?.name).filter(Boolean))];
  if (user.client?.name) clientNames.push(user.client.name);

  // The ATS reporting chain this person sits under — the STL and the TL named
  // on the requirements they are on. Distinct names only; a recruiter on four
  // requirements for the same desk has one TL, not four.
  const chainNames = async (ids) => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return [];
    const rows = await prisma.user.findMany({ where: { id: { in: unique } }, select: { name: true } });
    return rows.map((r) => r.name);
  };
  const [stlNames, tlNames] = await Promise.all([
    chainNames(requirements.map((r) => r.stlId)),
    chainNames(requirements.map((r) => r.tlId)),
  ]);

  return {
    id: user.id,
    // How many logins use this email (1 = the normal case), and whether this is the person's main login or an extra one.
    loginsOnEmail: c.emailCounts.get(String(user.email || '').trim().toLowerCase()) || 1,
    isExtraLogin: !!linkedEmp,
    roleLabel: LA.roleLabelOf(user),
    name: user.name,
    email: user.email,
    username: user.username || user.email,
    // The ACCOUNT-LEVEL role — Super Admin / Admin / the external account
    // kinds. Not what any product resolves against.
    role: user.role,
    productAccess: productAccessOf(user),
    products: { hrms: !!user.hrmsAccess, ats: !!user.atsAccess, accounts: !!user.accountsAccess },
    // ONE LOGIN, THREE PRODUCT ROLES — what the Users screen breaks down.
    productRoles: {
      hrms: user.hrmsAccess ? (named(user.hrmsRole) || user.role) : NO_ROLE,
      ats: user.atsAccess ? (named(user.atsRole) || user.role) : NO_ROLE,
      accounts: user.accountsAccess ? (named(user.accountsRole) || user.role) : NO_ROLE,
    },
    hrmsRole: user.hrmsAccess ? (named(user.hrmsRole) || user.role) : NO_ROLE,
    accountsRole: user.accountsAccess ? (named(user.accountsRole) || user.role) : NO_ROLE,
    atsRole: user.atsRole || null,
    // The ATS reporting chain, for the ATS column of the Users screen.
    atsStl: [...new Set(stlNames)],
    atsTl: [...new Set(tlNames)],
    mobile: emp?.phone || null,
    atsScopeDepartments: user.atsScopeDepartments || '',
    atsScopeTeams: user.atsScopeTeams || '',
    atsScopeClients: user.atsScopeClients || '',
    status: user.status || 'Active',
    employeeId: emp ? emp.employeeCode : null,
    employeeRecordId: emp ? emp.id : null,
    // The HR side of the person — an exited employee can still hold an Active login.
    employmentStatus: emp ? emp.employmentStatus : null,
    department: emp?.department || user.atsDepartment || null,
    designation: emp?.designation || null,
    branch: user.branch || emp?.branch || emp?.location || null,
    team: user.team || emp?.team || null,
    atsDepartment: user.atsDepartment,
    // "Scope — how far their access reaches", the prototype's userScopeLabel(),
    // now computed from the real stored scope rather than one department field.
    scope: scopeLabelOf(user, emp),
    assignedClients: [...new Set(clientNames)],
    assignedRequirements: requirements.length,
    lastLoginAt: user.lastLoginAt,
    // Password Set / Changed · date / Reset Required, and Locked / Active —
    // flags and dates only, never the password (hrms-24 §12).
    passwordStatus: passwordStatusOf(user),
    createdAt: user.createdAt,
  };
}

// "N accounts still use a starting password" - Super Admin only, names only, never the password.
router.get('/users/starting-password', async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only a Super Admin can see this.' });
  const list = await require('../utils/seedPasswords').accountsOnStartingPassword(); // eslint-disable-line global-require
  res.json({ count: list.length, accounts: list.map((a) => ({ id: a.id, name: a.name, role: a.role })) });
});

router.get('/users', requirePerm(null, 'administration', 'Users', 'view'), async (req, res) => {
  const users = await prisma.user.findMany({
    include: { employee: true, client: true },
    orderBy: { name: 'asc' },
  });
  const ctx = await loginContext(users);
  res.json(await Promise.all(users.map((u) => shapeUser(u, ctx))));
});

// Employees with no login yet — the "Create login" picker on the Users screen.
router.get('/users/employees-without-login', requirePerm(null, 'administration', 'Users', 'view'), async (req, res) => {
  const employees = await prisma.employee.findMany({
    where: { userId: null },
    select: { id: true, employeeCode: true, name: true, email: true, department: true, team: true, designation: true, branch: true, location: true },
    orderBy: { name: 'asc' },
  });
  res.json(employees);
});

// CREATE LOGIN.
//
// THE NORMAL CASE is unchanged: one login per person, the Admin types a first password, the owner must change it.
//
// SEPARATE LOGINS ON ONE EMAIL (founder, 2026-10-21). When the Admin ticks "Create another separate login on this email"
// (additionalLogin) the new login:
//   * may use an email that already has a login (the Users screen shows those logins first: role, department, employee, status);
//   * is its OWN account (own password, own roles / modules) - exactly what is ticked on this form, nothing inherited
//     from the person's other logins and nothing derived from the email;
//   * has NO password typed by anybody: it is emailed a single-use link bound to THIS login, and the person chooses the password;
//   * is linked to the SAME Employee record as the person's main login (no second employee is created). Employee.userId stays on the
//     main login; the extra one is recorded in EmployeeLogin.
// While the database still holds the old one-login-per-email rule the Admin gets a plain message (never a 500), see multiLoginOn.
router.post('/users', requirePerm(null, 'administration', 'Users', 'create'), async (req, res) => {
  const {
    name, email, password, role, atsDepartment, clientId, employeeId, branch, team, username, status, additionalLogin, sendActivation,
  } = req.body;
  const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1';
  const extra = isTrue(additionalLogin);
  const activate = extra || isTrue(sendActivation);
  if (!name || !email || !role || (!password && !activate)) return res.status(400).json({ error: 'name, email, password and role are required' });
  if (extra && password) return res.status(400).json({ error: 'A separate login chooses its own password. Leave the password empty: we email a link to set it.' });
  if (!ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (status && !USER_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  if (role === 'CLIENT' && !clientId) return res.status(400).json({ error: 'A Client login must be tied to one client' });
  if (extra && ['CLIENT', 'CANDIDATE'].includes(role)) return res.status(400).json({ error: 'Client and candidate logins are made from their own screens.' });
  { const bad = await productRoleError(req.body); if (bad) return res.status(400).json({ error: bad }); }
  // SECURITY (2026-10-13): only a Super Admin makes a Super Admin / Admin; nobody hands out more than the guard allows.
  { const why = await require('../utils/roleGuard').checkRoleChange({ actor: req.user, current: null, next: { role, atsDepartment, ...productRoleFields(req.body) } }); if (why) return res.status(403).json({ error: why }); } // eslint-disable-line global-require

  // An extra login gets EXACTLY the products ticked here: every product not ticked is off with the explicit role NONE, so nothing is
  // filled in from the employee's designation and nothing is granted because an email already has a login.
  const access = accessPatch(req.body);
  if (extra) {
    let anyProduct = false;
    for (const [p, label] of [['hrms', 'HRMS'], ['ats', 'ATS'], ['accounts', 'Accounts']]) {
      const on = access[`${p}Access`] === true;
      if (on && !(access[`${p}Role`] && access[`${p}Role`] !== 'NONE')) return res.status(400).json({ error: `Choose a role for ${label}, or set ${label} to No Access.` });
      if (!on) { access[`${p}Access`] = false; access[`${p}Role`] = 'NONE'; }
      anyProduct = anyProduct || on;
    }
    if (!anyProduct && !['SUPER_ADMIN', 'ADMIN'].includes(role)) return res.status(400).json({ error: 'Choose what this login can open: at least one of HRMS, ATS or Accounts.' });
  }

  // THE EMAIL. Case-insensitive, because "Kiran@x" and "kiran@x" are the same mailbox and SQLite's = is case-sensitive.
  const norm = String(email).trim().toLowerCase();
  const sameEmail = await LA.accountsByEmail(norm);
  if (sameEmail.length && !extra) {
    const n = sameEmail.length;
    return res.status(409).json({
      error: `That email already has ${n === 1 ? 'a login' : `${n} logins`}. To add another, separate login on the same email, tick "Create another separate login on this email".`,
      code: 'EMAIL_HAS_LOGINS',
      existing: await LA.summariesFor(sameEmail),
    });
  }
  if (sameEmail.length && extra && !(await LA.state({ fresh: true })).multiLoginOn) {
    return res.status(409).json({
      error: 'This email is still locked to one login: run the one-time upgrade. A Super Admin can switch it on from the banner at the top of this page.',
      code: 'MULTI_LOGIN_OFF',
    });
  }

  let linkEmployee = null;
  let linkAs = null; // 'primary' | 'extra'
  if (employeeId) {
    linkEmployee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!linkEmployee) return res.status(404).json({ error: 'Employee not found' });
    if (linkEmployee.userId) {
      if (!extra) return res.status(409).json({ error: 'That employee already has a login' });
      linkAs = 'extra';
    } else {
      linkAs = 'primary';
    }
  }
  // An EMPLOYEE record with this email is the same person. A second main login for them is exactly what the one-user model forbids:
  // give the ATS role to their existing login on this screen, or pick the employee here so this login is linked to them.
  if (!['CLIENT', 'CANDIDATE'].includes(role)) {
    const [emp] = await prisma.$queryRaw`SELECT id, userId, name, employeeCode FROM Employee WHERE lower(trim(email)) = ${norm} LIMIT 1`;
    if (emp && emp.id !== employeeId) {
      if (extra) {
        return res.status(409).json({
          error: `That email belongs to employee ${emp.name} (${emp.employeeCode}). Select that employee so the separate login is linked to them (no second employee is created).`,
          code: 'PICK_EMPLOYEE',
        });
      }
      return res.status(409).json({
        error: emp.userId
          ? `${emp.name} (${emp.employeeCode}) already has a login. Add the ATS / Accounts role to that login instead of creating a second one, or tick "Create another separate login on this email".`
          : `That email belongs to employee ${emp.name} (${emp.employeeCode}). Select that employee so the login is linked to them.`,
        code: emp.userId ? 'EMPLOYEE_HAS_LOGIN' : 'PICK_EMPLOYEE',
      });
    }
  }

  const passwordHash = activate
    ? await require('../utils/employeeInvite').unguessablePasswordHash() // eslint-disable-line global-require
    : await bcrypt.hash(password, 10);
  let user;
  try {
    user = await prisma.user.create({
      data: {
        // The administrator typed this first password, so its owner must change it (hrms-24 §12). An activation login has none yet.
        ...(activate ? {} : passwordEventData('initial')),
        name, email, passwordHash, role, atsDepartment, clientId,
        branch, team, username: username || email, status: status || 'Active',
        ...access,
      },
    });
  } catch (err) {
    // The database still forces one login per email (the one-time upgrade has not been run).
    if (err && err.code === 'P2002') {
      return res.status(409).json({ error: 'This email is still locked to one login: run the one-time upgrade. A Super Admin can switch it on from the banner at the top of this page.', code: 'MULTI_LOGIN_OFF' });
    }
    throw err;
  }

  // Access is granted TO an existing employee - never a second identity. (Validated above, before the login was created.)
  if (linkEmployee && linkAs === 'primary') {
    await prisma.employee.update({ where: { id: linkEmployee.id }, data: { userId: user.id } });
  } else if (linkEmployee && linkAs === 'extra') {
    await LA.linkEmployee(user.id, linkEmployee.id, req.user.id);
  }

  await logAudit({ userId: req.user.id, action: extra ? 'Separate login created on a shared email' : 'User created', entity: 'User', entityId: user.id, toValue: `${role} · ${user.status}` });
  await require('../utils/roleGuard').noteRoleChange({ actor: req.user, current: { id: user.id, name: user.name }, next: { role, ...productRoleFields({ ...req.body, ...access }) }, source: extra ? 'new separate login' : 'new login' }); // eslint-disable-line global-require
  let activation = null;
  if (activate) activation = await require('../utils/loginActivation').sendActivation({ user, byUser: req.user }); // eslint-disable-line global-require
  const shaped = await shapeUser(await prisma.user.findUnique({ where: { id: user.id }, include: { employee: true, client: true } }));
  res.status(201).json({ ...shaped, activation });
});

router.put('/users/:id', requirePerm(null, 'administration', 'Users', 'edit'), async (req, res) => {
  const { name, role, atsDepartment, branch, team, status, username } = req.body;
  if (role && !ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (status && !USER_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'User not found' });
  { const bad = await productRoleError(req.body, existing); if (bad) return res.status(400).json({ error: bad }); }
  // SECURITY (2026-10-13): role escalation guard (Admin cannot make / edit a Super Admin or an Admin, nobody edits their own role).
  const roleGuard = require('../utils/roleGuard'); // eslint-disable-line global-require
  const wantedRoles = { role, atsDepartment, ...productRoleFields(req.body) };
  { const why = await roleGuard.checkRoleChange({ actor: req.user, current: existing, next: wantedRoles }); if (why) return res.status(403).json({ error: why }); }
  if ((status || username || name) && existing.id !== req.user.id) {
    const why = roleGuard.checkPasswordTarget({ actor: req.user, target: existing });
    if (why && status && status !== existing.status) return res.status(403).json({ error: 'Only a Super Admin can switch off a Super Admin or an Admin login.' });
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { name, role, atsDepartment, branch, team, status, username, ...accessPatch(req.body) },
    include: { employee: true, client: true },
  });
  await roleGuard.noteRoleChange({ actor: req.user, current: existing, next: wantedRoles, source: 'Users screen' });
  if (role && role !== existing.role) {
    await logAudit({ userId: req.user.id, action: `Role changed for ${user.name}`, entity: 'User', entityId: user.id, fromValue: existing.role, toValue: role });
  }
  if (status && status !== existing.status) {
    await logAudit({ userId: req.user.id, action: `Login ${status.toLowerCase()} for ${user.name}`, entity: 'User', entityId: user.id, fromValue: existing.status, toValue: status });
  }
  if (!role && !status) {
    await logAudit({ userId: req.user.id, action: 'User updated', entity: 'User', entityId: user.id });
  }
  res.json(await shapeUser(user));
});

// Suspend / restore a login without touching its role.
router.post('/users/:id/toggle-status', requirePerm(null, 'administration', 'Users', 'edit'), async (req, res) => {
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'User not found' });
  if (existing.id === req.user.id) return res.status(409).json({ error: 'You cannot disable your own login' });
  if (require('../utils/roleGuard').checkPasswordTarget({ actor: req.user, target: existing })) return res.status(403).json({ error: 'Only a Super Admin can switch off a Super Admin or an Admin login.' }); // eslint-disable-line global-require
  const next = (existing.status || 'Active') === 'Active' ? 'Inactive' : 'Active';
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: next }, include: { employee: true, client: true } });
  await logAudit({ userId: req.user.id, action: `Login ${next === 'Active' ? 'enabled' : 'disabled'} for ${user.name}`, entity: 'User', entityId: user.id, fromValue: existing.status, toValue: next });
  res.json(await shapeUser(user));
});

router.post('/users/:id/reset-password', requirePerm(null, 'administration', 'Users', 'edit'), async (req, res) => {
  const { password } = req.body;
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'User not found' });
  { const why = require('../utils/roleGuard').checkPasswordTarget({ actor: req.user, target: existing }); if (why) return res.status(403).json({ error: why }); } // eslint-disable-line global-require
  const weak = strengthError(password, { email: existing.email, name: existing.name });
  if (weak) return res.status(400).json({ error: weak });
  // The new hash is live at once; the owner must change it at their next
  // sign-in (passwordResetRequired), any lock is lifted and any pending
  // set-password link stops working.
  await prisma.user.update({
    where: { id: req.params.id },
    data: {
      passwordHash: await bcrypt.hash(String(password), 10),
      ...passwordEventData('admin'),
      setPasswordTokenHash: null, setPasswordExpiresAt: null,
    },
  });
  // The new password is never echoed back or logged.
  await logAudit({ userId: req.user.id, action: `Password reset for ${existing.name}`, entity: 'User', entityId: existing.id, toValue: 'Reset — change required at next sign-in' });
  // Older sessions end; Super Admin / Admin are told THAT it changed (never what it is).
  const afterReset = await prisma.user.findUnique({ where: { id: existing.id } });
  await passwordReset.afterPasswordChange({ user: afterReset, method: 'admin_reset', byUserId: req.user.id, byName: req.user.name });
  res.json({ ok: true, passwordStatus: passwordStatusOf(afterReset) });
});

// GET RESET LINK - the safer way to get someone back in. The Admin never types or
// learns a password: the link is shown ON SCREEN once, to hand over; the person
// opens it and chooses their own. Works once, for ADMIN_LINK_TTL_MIN minutes.
router.post('/users/:id/reset-link', requirePerm(null, 'administration', 'Users', 'edit'), async (req, res) => {
  if (!['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Only a Super Admin or an Admin can make a reset link.' });
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'For your own password, use Change password in My Profile.' });
  { const why = require('../utils/roleGuard').checkPasswordTarget({ actor: req.user, target }); if (why) return res.status(403).json({ error: why.replace('reset the password of', 'make a reset link for') }); } // eslint-disable-line global-require
  if ((target.status || 'Active') !== 'Active') return res.status(409).json({ error: 'This login is switched off. Enable it first.' });
  const out = await passwordReset.adminLink(req, target);
  res.json({ ok: true, name: target.name, link: out.link, expiresAt: out.expiresAt, minutes: out.minutes });
});

// WHO IS TOLD when someone changes their password (Company Setup).
router.get('/password-alert-setting', async (req, res) => {
  if (!['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Only a Super Admin or an Admin can see this.' });
  const setting = await passwordReset.readSetting();
  const people = await prisma.user.findMany({
    where: { status: 'Active', role: { in: setting.roles } }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' },
  });
  res.json({ ...setting, canEdit: req.user.role === 'SUPER_ADMIN', people });
});

router.put('/password-alert-setting', async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only a Super Admin can change who is told.' });
  const out = await passwordReset.writeSetting(req.user, req.body || {});
  res.json(out);
});

// ---- Add Employee and the email one-time code that gates it ----
//
// MOVED to routes/employees.js (POST /api/employees/management, plus
// /management/email-otp/send and /verify). They lived here behind
// `administration / Users`, which is Super Admin + Admin only; they now sit
// behind `hrms / Employee Management / create`, which is what the Employee
// Management screen itself asks for, so an HR lead can add an employee into
// their own scope. There is ONE Add Employee in the app and it is that one.

// ---- Designation -> ATS role mapping ----
//
// THE mapping. Data, not a switch statement: change "Recruiter -> RECRUITER"
// here and every Recruiter in every department follows, because the department
// supplies the scope and the designation supplies the role. There is no
// "Medical TL" anywhere in the system, only department=Medical + designation=TL.
router.get('/designation-roles', requirePerm(null, 'administration', 'Users', 'view'), async (req, res) => {
  res.json({
    rows: (await designationRows()).map(normaliseMapping),
    atsRoles: ATS_ROLES,
    // The vocabulary for the other two product-role columns.
    hrmsRoles: [NO_ROLE, ...ALL_ROLES],
    accountsRoles: [NO_ROLE, ...ALL_ROLES],
    designations: [...new Set((await prisma.employee.findMany({ select: { designation: true } }))
      .map((e) => e.designation).filter(Boolean))].sort(),
  });
});

// DERIVATION STAYS. A designation maps to ALL THREE product roles here, and
// never to a compound name: there is no "Medical Recruiter" role, only
// department=Medical + atsRole=RECRUITER.
router.put('/designation-roles/:designation', requirePerm(null, 'administration', 'Users', 'configure'), async (req, res) => {
  const designation = decodeURIComponent(req.params.designation);
  const {
    atsRole, hrmsRole, accountsRole, hrms, ats, accounts, landing,
  } = req.body;
  if (req.user.role !== 'SUPER_ADMIN' && [atsRole, hrmsRole, accountsRole].some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r))) {
    return res.status(403).json({ error: 'Only a Super Admin can map a designation to the Admin or Super Admin role.' });
  }
  if (atsRole && !ATS_ROLES.includes(atsRole)) return res.status(400).json({ error: 'Unknown ATS role' });
  if (hrmsRole && hrmsRole !== NO_ROLE && !ALL_ROLES.includes(hrmsRole)) return res.status(400).json({ error: 'Unknown HRMS role' });
  if (accountsRole && accountsRole !== NO_ROLE && !ALL_ROLES.includes(accountsRole)) return res.status(400).json({ error: 'Unknown Accounts role' });
  const data = {
    atsRole: atsRole || null,
    hrms: hrms !== undefined ? !!hrms : true,
    ats: ats !== undefined ? !!ats : !!atsRole,
    accounts: accounts !== undefined ? !!accounts : false,
    landing: landing || null,
  };
  // An explicit role wins; otherwise the row keeps deriving the same value
  // the engine would have derived for it.
  if (hrmsRole !== undefined) data.hrmsRole = hrmsRole || NO_ROLE;
  if (accountsRole !== undefined) data.accountsRole = accountsRole || NO_ROLE;
  const row = await prisma.designationRole.upsert({
    where: { designation },
    create: { designation, ...data },
    update: data,
  });
  invalidateDesignationMap();
  await logAudit({
    userId: req.user.id, action: 'Designation mapping changed', entity: 'DesignationRole',
    entityId: designation, toValue: atsRole || 'No ATS role',
  });
  res.json(row);
});

// ---- Role catalog ----
//
// The prototype carries two unreconciled permission matrices. This follows
// `roleAccessFor` (the one the Role Catalog UI actually edits), not
// `rolePermissions` — see the note at the top of utils/roleAccess.js.
// ADMINISTRATION IS NOT PUBLIC. This GET carried no guard, so any signed-in
// login — a recruiter, an accountant, a candidate — could read the whole role/permission matrix.
// It is guarded by the same feature its screen is now.
router.get('/role-catalog', requirePerm(null, 'administration', 'Role Catalog', 'view'), async (req, res) => {
  const [counts, rows] = await Promise.all([
    prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
    prisma.roleAccess.findMany(),
  ]);
  const countFor = (role) => counts.find((c) => c.role === role)?._count._all || 0;
  // ROLES ARE DATA: the system roles and every custom role (utils/roleRegistry.js).
  const registry = await listRoles();
  // P12 (user, 2026-10-09): a person holds a role in a PRODUCT too. A BDE or a
  // Recruiter is an Employee at account level (role = EMPLOYEE) and a BDE / Recruiter
  // in ATS, so counting the account role alone showed BDE = 0. Users per role =
  // the logins that hold it at account level OR in any product.
  const productCounts = {};
  for (const reg of registry.filter((x) => x.isSystem)) {
    // eslint-disable-next-line no-await-in-loop
    productCounts[reg.code] = await prisma.user.count({
      where: { OR: [{ role: reg.code }, { atsRole: reg.code }, { hrmsRole: reg.code }, { accountsRole: reg.code }] },
    });
  }
  const customCounts = {};
  for (const r of registry.filter((x) => !x.isSystem)) {
    // eslint-disable-next-line no-await-in-loop
    customCounts[r.code] = await holdersOf(r.code);
  }

  res.json(registry.map((reg) => {
    const role = reg.code;
    const modules = ROLE_ACCESS_MODULES.map((m) => {
      const merged = mergeAccess(role, m.id, ...rowsFor(rows, role, m.id));
      return {
        id: m.id,
        label: m.label,
        // PRODUCT → MODULE. Which product this module's grid belongs to, so
        // the catalog can group by product instead of listing ten modules
        // flat and leaving the reader to guess.
        product: productOf(m.id),
        enabled: merged.moduleEnabled,
      };
    });
    const enabled = modules.filter((m) => m.enabled);
    return {
      role,
      name: reg.name,
      isSystem: reg.isSystem,
      status: reg.status,
      description: reg.description,
      scopeLevel: reg.scopeLevel,
      behavesLike: reg.behavesLike,
      permissions: reg.permissions,
      grants: reg.products,
      users: reg.isSystem ? Math.max(countFor(role), productCounts[role] || 0) : (customCounts[role] || 0),
      scope: ROLE_SCOPE_DESC[role] || reg.scopeDesc || '—',
      // Which products this role reaches at all — the top level of
      // Product → Module → Feature → Action.
      products: PRODUCTS.map((p) => p.id).filter((p) => enabled.some((m) => m.product === p)),
      // Kept so anything still reading the old flat shape keeps working.
      access: enabled.length === ROLE_ACCESS_MODULES.length
        ? 'Full access to every module'
        : enabled.map((m) => m.label).join(', ') || 'No module access',
      modules,
    };
  }));
});

// The module + feature catalog itself, so the UI never hard-codes it.
// ADMINISTRATION IS NOT PUBLIC. This GET carried no guard, so any signed-in
// login — a recruiter, an accountant, a candidate — could read the module/feature catalog.
// It is guarded by the same feature its screen is now.
router.get('/role-catalog/modules', requirePerm(null, 'administration', 'Role Catalog', 'view'), (req, res) => {
  res.json({
    actions: ROLE_FEATURE_ACTIONS,
    // PRODUCT → MODULE → FEATURE → ACTION, in that order, as data.
    products: PRODUCTS,
    modules: ROLE_ACCESS_MODULES.map((m) => ({ ...m, product: productOf(m.id), featureInfo: featureInfoOf(m.id) })),
    productOfModule: PRODUCT_OF_MODULE,
  });
});

// ---- Roles as data (Role & Permission Management) ----
//
// "When Super Admin creates a role it must automatically become available
// throughout the application. Do NOT hardcode the role dropdown." Every role
// picker reads GET /admin/roles; Role Catalog adds custom roles with their own
// permission matrix (deny by default). See utils/roleRegistry.js.
const MANAGE_ROLES = [
  requirePerm(null, 'administration', 'Role Catalog', 'configure'),
  requirePerm(null, 'administration', 'Users', 'configure'),
];

// The role list for dropdowns. Any screen that assigns or filters by role
// reads this: Employee Management (HR desk, leads), Users, Role Catalog.
router.get('/roles', async (req, res) => {
  const [em, users, catalog] = await Promise.all([
    canPerm(req.user, null, 'hrms', 'Employee Management', 'view'),
    canPerm(req.user, null, 'administration', 'Users', 'view'),
    canPerm(req.user, null, 'administration', 'Role Catalog', 'view'),
  ]);
  if (!em && !users && !catalog) return res.status(403).json(DENIED_ROLES);
  const all = await listRoles();
  const list = req.query.all === '1' ? all : all.filter((r) => r.active || r.isSystem);
  res.json(list.map((r) => ({
    code: r.code, name: r.name, description: r.description, status: r.status, active: r.active,
    isSystem: r.isSystem, external: r.external, scopeLevel: r.scopeLevel, products: r.products,
  })));
});
const DENIED_ROLES = { error: "This action isn't included in your role's permissions" };

// What the Add / Edit Role form needs.
router.get('/role-catalog/meta', requirePerm(null, 'administration', 'Role Catalog', 'view'), async (req, res) => {
  const [mayConfigure, mayUsers] = await Promise.all([
    canPerm(req.user, null, 'administration', 'Role Catalog', 'configure'),
    canPerm(req.user, null, 'administration', 'Users', 'configure'),
  ]);
  res.json({
    rows: MATRIX_ROWS.map((r) => ({ id: r.id, label: r.label, product: r.product })),
    actions: MATRIX_ACTIONS,
    scopeLevels: SCOPE_LEVELS.map((id) => ({ id, label: SCOPE_LEVEL_LABEL[id], alias: SCOPE_ALIAS[id] })),
    behavesLikeAts: BEHAVES_LIKE_ATS,
    templates: (await listRoles()).filter((r) => !r.external && r.code !== 'SUPER_ADMIN').map((r) => ({ code: r.code, name: r.name })),
    canManage: !!(mayConfigure && mayUsers),
  });
});

// A role's current access as the simple matrix — the "starting template".
router.get('/role-catalog/template/:role', requirePerm(null, 'administration', 'Role Catalog', 'view'), async (req, res) => {
  const role = await roleByCode(req.params.role);
  if (!role) return res.status(404).json({ error: 'Unknown role' });
  res.json({ code: role.code, matrix: await matrixFromRole(role.code, accessFor), scopeLevel: role.scopeLevel });
});

function parseRoleBody(body, { creating }) {
  const b = body || {};
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  if (creating || b.name !== undefined) {
    if (!name) return { error: 'Enter the role name.' };
    if (name.length > 60) return { error: 'Keep the role name to 60 characters or fewer.' };
  }
  const status = b.status === undefined ? undefined : (b.status === 'Inactive' ? 'Inactive' : 'Active');
  const scopeLevel = b.scopeLevel === undefined ? undefined : String(b.scopeLevel).toUpperCase();
  if (scopeLevel !== undefined && !SCOPE_LEVELS.includes(scopeLevel)) return { error: 'Choose a data scope: Own records, Team, Department or All.' };
  const behavesAts = b.behavesLike && b.behavesLike.ats ? String(b.behavesLike.ats).toUpperCase() : null;
  if (behavesAts && !BEHAVES_LIKE_ATS.includes(behavesAts)) return { error: `"${b.behavesLike.ats}" is not an ATS role a custom role can behave like.` };
  const permissions = b.permissions === undefined ? undefined : cleanMatrix(b.permissions);
  if (permissions !== undefined) {
    const products = productsOfMatrix(permissions);
    if (!products.hrms && !products.ats && !products.accounts) {
      return { error: 'Tick at least one permission in an HRMS, Recruitment, Clients or Accounts row — otherwise the role grants nothing an employee can use.' };
    }
  }
  return {
    data: {
      ...(creating || b.name !== undefined ? { name } : {}),
      ...(b.description !== undefined ? { description: String(b.description || '').trim().slice(0, 300) || null } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(scopeLevel !== undefined ? { scopeLevel } : {}),
      ...(b.behavesLike !== undefined ? { behavesLike: behavesAts ? { ats: behavesAts } : {} } : {}),
      ...(permissions !== undefined ? { permissions, products: productsOfMatrix(permissions) } : {}),
    },
  };
}

// Write a role's matrix into the engine's RoleAccess rows. Every module the
// matrix covers is rewritten (so un-ticking revokes); other modules
// (Dashboard, Administration) are left to Role Catalog -> Edit Access.
async function writeRoleMatrix(code, matrix) {
  for (const row of engineRowsFor(matrix)) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.roleAccess.upsert({
      where: { role_product_moduleId: { role: code, product: row.product, moduleId: row.moduleId } },
      create: { role: code, product: row.product, moduleId: row.moduleId, moduleEnabled: row.moduleEnabled, features: JSON.stringify(row.features) },
      update: { moduleEnabled: row.moduleEnabled, features: JSON.stringify(row.features) },
    });
  }
  invalidateRoleAccess(code);
}

const matrixSummary = (m) => Object.entries(m || {}).map(([k, v]) => `${k}: ${v.join('/')}`).join('; ') || 'none';

router.post('/role-catalog/roles', ...MANAGE_ROLES, async (req, res) => {
  const parsed = parseRoleBody(req.body, { creating: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { data } = parsed;
  if (!data.permissions) return res.status(400).json({ error: 'Tick the permissions this role grants.' });
  const all = await listRoles();
  if (all.some((r) => r.name.toLowerCase() === data.name.toLowerCase() || r.code.toLowerCase() === data.name.toLowerCase())) {
    return res.status(409).json({ error: `A role called "${data.name}" already exists.` });
  }
  // Company-wide ATS / Accounts reach is Admin-like; only a Super Admin may
  // hand that out.
  if (data.scopeLevel === 'ALL' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only a Super Admin may create a role with company-wide (All) scope.' });
  }
  const code = await newRoleCode(data.name);
  const role = await insertRole({ ...data, code, scopeLevel: data.scopeLevel || 'OWN', createdById: req.user.id });
  await writeRoleMatrix(code, data.permissions);
  // AI Assistant & Agent: a new custom role starts with the same defaults a
  // system role has (utils/roleRegistry.js aiRowFor); Edit Access changes it.
  const ai = aiRowFor(data.permissions);
  await prisma.roleAccess.upsert({
    where: { role_product_moduleId: { role: code, product: ai.product, moduleId: ai.moduleId } },
    create: { role: code, product: ai.product, moduleId: ai.moduleId, moduleEnabled: ai.moduleEnabled, features: JSON.stringify(ai.features) },
    update: {},
  });
  invalidateRoleAccess(code);
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Role created', entity: 'Role', entityId: code,
    toValue: `${role.name} · ${role.status} · scope ${role.scopeLevel} · ${matrixSummary(role.permissions)}`,
  });
  res.status(201).json(role);
});

router.put('/role-catalog/roles/:code', ...MANAGE_ROLES, async (req, res) => {
  const existing = await roleByCode(req.params.code);
  if (!existing) return res.status(404).json({ error: 'Unknown role' });
  if (existing.isSystem) {
    return res.status(409).json({ error: 'A system role is edited on Edit Access; its name and status are fixed.' });
  }
  const parsed = parseRoleBody(req.body, { creating: false });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { data } = parsed;
  if (data.name && data.name !== existing.name) {
    const all = await listRoles();
    if (all.some((r) => r.code !== existing.code && r.name.toLowerCase() === data.name.toLowerCase())) {
      return res.status(409).json({ error: `A role called "${data.name}" already exists.` });
    }
  }
  if (data.scopeLevel === 'ALL' && existing.scopeLevel !== 'ALL' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only a Super Admin may give a role company-wide (All) scope.' });
  }
  const role = await updateRole(existing.code, data);
  if (data.permissions) await writeRoleMatrix(existing.code, data.permissions);
  const holders = await holdersOf(existing.code);
  const changes = [];
  if (data.name && data.name !== existing.name) changes.push(`name ${existing.name} -> ${data.name}`);
  if (data.status && data.status !== existing.status) changes.push(`status ${existing.status} -> ${data.status}`);
  if (data.scopeLevel && data.scopeLevel !== existing.scopeLevel) changes.push(`scope ${existing.scopeLevel} -> ${data.scopeLevel}`);
  if (data.permissions) changes.push(`permissions: ${matrixSummary(data.permissions)}`);
  if (data.description !== undefined && data.description !== existing.description) changes.push('description');
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: data.status && data.status !== existing.status ? `Role ${data.status === 'Inactive' ? 'deactivated' : 'activated'}` : 'Role edited',
    entity: 'Role', entityId: existing.code, fromValue: `${existing.name} · ${existing.status}`,
    toValue: changes.join('; ') || 'No change',
  });
  // Holders keep working while it is inactive; the UI warns with this count.
  res.json({ ...role, holders });
});

// One role's full matrix: every module, every feature, every action.
router.get('/role-catalog/:role/access', requirePerm(null, 'administration', 'Role Catalog', 'view'), async (req, res) => {
  const { role } = req.params;
  if (!(await isKnownRole(role))) return res.status(404).json({ error: 'Unknown role' });
  const rows = await prisma.roleAccess.findMany({ where: { role } });
  // A custom role is held to the same fixed-off boxes as the system role it behaves like (2026-10-13).
  const lockRole = CATALOG_ROLES.includes(role) ? role : (await require('../utils/roleRegistry').scopeAliasFor(role, 'ats').catch(() => role)); // eslint-disable-line global-require
  res.json({
    role,
    scope: ROLE_SCOPE_DESC[role] || '—',
    actions: ROLE_FEATURE_ACTIONS,
    products: PRODUCTS,
    modules: ROLE_ACCESS_MODULES.map((m) => ({
      id: m.id,
      label: m.label,
      product: productOf(m.id),
      featureNames: m.features,
      // Plain tick-line groups shown above the grid (Clients / Requirements / Business activities / Reports) - utils/roleAccess.js.
      groups: require('../utils/roleAccess').PERMISSION_GROUPS[m.id] || null, // eslint-disable-line global-require
      // HRMS / Accounts modules: what each feature drives and whether an
      // endpoint checks it by name (utils/roleAccess.js SPLIT_MODULES).
      featureInfo: featureInfoOf(m.id),
      // Manager / Assistant Manager: actions the server ignores (§3/§4).
      locked: (() => {
        // view-only roles (Manager / Asst Manager) + the hard locks: posting a job is never a Recruiter's, booking an interview is the BDE's alone
        const a = viewOnlyLocksFor(role, m.id); const b = hardLocksFor(lockRole, m.id);
        if (!b) return a;
        const out = { ...(a || {}) };
        Object.entries(b).forEach(([f, acts]) => { out[f] = [...new Set([...(out[f] || []), ...acts])]; });
        return out;
      })(),
      lockNote: hardLocksFor(lockRole, m.id)
        ? (m.id === 'requirements' ? [lockRole === 'RECRUITER' ? 'Posting a requirement (Save & Post, job sites, Job Portal publish and sync, creating, editing and opening a requirement) is not a Recruiter\'s requirement. These boxes stay off whatever is ticked.' : '', require('../utils/jobCreateRule').lockNoteFor(lockRole)].filter(Boolean).join(' ') : 'Only the client manager (BDE) books interviews: book, move, cancel. These boxes stay off for this role whatever is ticked. Feedback and viewing are not affected.')
        : null,
      ...clampHard(lockRole, m.id, mergeAccess(role, m.id, ...rowsFor(rows, role, m.id))),
    })),
  });
});

// Writes land on the row for the MODULE'S OWN PRODUCT, so saving ATS access
// for a role never touches what that same role name may do in HRMS.
async function upsertRoleAccess(role, moduleId, patch) {
  const product = productOf(moduleId);
  const all = await prisma.roleAccess.findMany({ where: { role, moduleId } });
  const current = mergeAccess(role, moduleId, ...rowsFor(all, role, moduleId));
  const next = { ...current, ...patch };
  await prisma.roleAccess.upsert({
    where: { role_product_moduleId: { role, product, moduleId } },
    create: { role, product, moduleId, moduleEnabled: next.moduleEnabled, features: JSON.stringify(next.features) },
    update: { moduleEnabled: next.moduleEnabled, features: JSON.stringify(next.features) },
  });
  // The permission engine caches the matrix; an admin's edit must bite now.
  invalidateRoleAccess(role);
  return next;
}

// Turn a whole module on or off for a role.
router.put('/role-catalog/:role/modules/:moduleId', requirePerm(null, 'administration', 'Role Catalog', 'configure'), async (req, res) => {
  const { role, moduleId } = req.params;
  if (['SUPER_ADMIN', 'ADMIN'].includes(role) && req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only a Super Admin can change what the Super Admin and Admin roles can do.' });
  if (!(await isKnownRole(role))) return res.status(404).json({ error: 'Unknown role' });
  const mod = moduleById(moduleId);
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });

  const before = mergeAccess(role, moduleId, ...rowsFor(await prisma.roleAccess.findMany({ where: { role, moduleId } }), role, moduleId));
  const next = await upsertRoleAccess(role, moduleId, { moduleEnabled: req.body.enabled });
  await logAudit({
    userId: req.user.id, action: 'Module access changed', entity: 'RoleAccess',
    entityId: `${role}/${moduleId}`, fromValue: before.moduleEnabled ? 'On' : 'Off', toValue: next.moduleEnabled ? 'On' : 'Off',
  });
  res.json({ role, moduleId, label: mod.label, ...next });
});

// Save one module's feature x action grid for a role.
router.put('/role-catalog/:role/modules/:moduleId/features', requirePerm(null, 'administration', 'Role Catalog', 'configure'), async (req, res) => {
  const { role, moduleId } = req.params;
  if (['SUPER_ADMIN', 'ADMIN'].includes(role) && req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only a Super Admin can change what the Super Admin and Admin roles can do.' });
  if (!(await isKnownRole(role))) return res.status(404).json({ error: 'Unknown role' });
  const mod = moduleById(moduleId);
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  if (!req.body.features || typeof req.body.features !== 'object') {
    return res.status(400).json({ error: 'features must be an object' });
  }
  const features = sanitizeFeatures(moduleId, req.body.features);
  const next = await upsertRoleAccess(role, moduleId, {
    features,
    ...(typeof req.body.enabled === 'boolean' ? { moduleEnabled: req.body.enabled } : {}),
  });
  await logAudit({
    userId: req.user.id, action: 'Feature permissions saved', entity: 'RoleAccess',
    entityId: `${role}/${moduleId}`, toValue: mod.label,
  });
  res.json({ role, moduleId, label: mod.label, ...next });
});

// ---- Departments & Teams (Super Admin-managed; everyone can read them for dropdowns) ----
// THE DEPARTMENT DROPDOWN, for the whole app.
//
// This endpoint is deliberately NOT permission-guarded: Attendance, Payroll,
// Announcements and Employee Detail all use it as their department picker, and
// a guard here would blank those screens. It returned all nine departments to
// every login, which is exactly the leak the user pointed at — "at least
// vallaki option kuda visible avvakudadhu".
//
// The fix is to SCOPE THE RESPONSE, not to refuse the request: the caller is
// offered the departments their own scope reaches and nothing else. A Medical
// TL is offered Medical; an external login is offered none.
router.get('/departments', async (req, res) => {
  const allowed = scopeDepartments(req.user);
  // Spec item 18 — pickers get ACTIVE departments and teams only. The
  // Departments & Teams screen asks for ?all=1 to see (and switch back on)
  // the ones that are off.
  const { activeOnly } = require('../utils/masters');
  const all = String(req.query.all || '') === '1';
  const departments = await prisma.department.findMany({
    where: { ...(allowed === undefined ? {} : { name: { in: allowed } }), ...(all ? {} : activeOnly('Department')) },
    include: { teams: { where: all ? {} : activeOnly('Team'), orderBy: { name: 'asc' } } },
    orderBy: { name: 'asc' },
  });
  res.json(departments);
});

// Spec item 18 — SWITCH A DEPARTMENT / TEAM OFF (or back on). Off = gone from
// every dropdown at once; employees already in it keep it on their record.
async function setMasterActive(req, res, model, label) {
  const { hasColumn } = require('../utils/masters');
  if (!hasColumn(model, 'active')) return res.status(503).json({ error: `Switching a ${label.toLowerCase()} off needs a database update that has not been applied yet.` });
  const delegate = model === 'Team' ? prisma.team : prisma.department;
  const row = await delegate.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: `${label} not found` });
  const active = req.body && req.body.active !== undefined ? !!req.body.active : !row.active;
  const saved = await delegate.update({ where: { id: row.id }, data: { active } });
  await logAudit({ userId: req.user.id, action: `${label} ${active ? 'switched on' : 'switched off'}`, entity: model, entityId: row.id, fromValue: row.active ? 'On' : 'Off', toValue: active ? 'On' : 'Off' });
  return res.json(saved);
}
router.put('/departments/:id/active', requirePerm(null, 'administration', 'Departments & Teams', 'edit'), (req, res) => setMasterActive(req, res, 'Department', 'Department'));
router.put('/teams/:id/active', requirePerm(null, 'administration', 'Departments & Teams', 'edit'), (req, res) => setMasterActive(req, res, 'Team', 'Team'));

router.post('/departments', requirePerm(null, 'administration', 'Departments & Teams', 'create'), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const department = await prisma.department.create({ data: { name: name.trim() } });
    await logAudit({ userId: req.user.id, action: 'Department added', entity: 'Department', entityId: department.id, toValue: department.name });
    res.status(201).json(department);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'That department already exists' });
    throw err;
  }
});

router.delete('/departments/:id', requirePerm(null, 'administration', 'Departments & Teams', 'delete'), async (req, res) => {
  const department = await prisma.department.findUnique({ where: { id: req.params.id } });
  if (!department) return res.status(404).json({ error: 'Department not found' });
  // Spec item 18 — a removed department must vanish from the dropdowns, which
  // it cannot while people are still filed under it. Say so, and offer Off.
  const inUse = await prisma.employee.count({ where: { department: department.name, employmentStatus: { notIn: ['Relieved', 'Exited'] } } });
  if (inUse) return res.status(409).json({ error: `${inUse} employee${inUse === 1 ? ' is' : 's are'} in ${department.name}. Move them to another department first, or press "Switch off" to hide it from the lists.` });
  await prisma.team.deleteMany({ where: { departmentId: req.params.id } });
  await prisma.department.delete({ where: { id: req.params.id } });
  await logAudit({ userId: req.user.id, action: 'Department removed', entity: 'Department', entityId: req.params.id, fromValue: department.name });
  res.json({ ok: true });
});

router.post('/departments/:id/teams', requirePerm(null, 'administration', 'Departments & Teams', 'create'), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const department = await prisma.department.findUnique({ where: { id: req.params.id } });
  if (!department) return res.status(404).json({ error: 'Department not found' });
  try {
    const team = await prisma.team.create({ data: { name: name.trim(), departmentId: req.params.id } });
    await logAudit({ userId: req.user.id, action: 'Team added', entity: 'Team', entityId: team.id, toValue: `${department.name} / ${team.name}` });
    res.status(201).json(team);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'That team already exists in this department' });
    throw err;
  }
});

router.delete('/teams/:id', requirePerm(null, 'administration', 'Departments & Teams', 'delete'), async (req, res) => {
  const team = await prisma.team.findUnique({ where: { id: req.params.id } });
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const teamDept = await prisma.department.findUnique({ where: { id: team.departmentId }, select: { name: true } });
  const inTeam = await prisma.employee.count({ where: { team: team.name, ...(teamDept ? { department: teamDept.name } : {}), employmentStatus: { notIn: ['Relieved', 'Exited'] } } });
  if (inTeam) return res.status(409).json({ error: `${inTeam} employee${inTeam === 1 ? ' is' : 's are'} in ${team.name}. Move them to another team first, or press "Switch off" to hide it from the lists.` });
  await prisma.team.delete({ where: { id: req.params.id } });
  await logAudit({ userId: req.user.id, action: 'Team removed', entity: 'Team', entityId: req.params.id, fromValue: team.name });
  res.json({ ok: true });
});

// ---- Company setup ----
//
// The prototype's Company Setup (companySetupView, line 9693) is a two-column
// screen: Company Information + Employment Policies on the left, Departments,
// Working Locations and Teams on the right.
function shapeCompany(company, departments, teams) {
  let policies = [];
  try { policies = company.policies ? JSON.parse(company.policies) : []; } catch { policies = []; }
  if (!policies.length) policies = COMPANY_POLICIES;
  return {
    ...company,
    policies,
    // The right-hand column's reference lists.
    departments: departments.length ? departments.map((d) => d.name) : DEPTS,
    locations: LOCS,
    teams,
  };
}

async function companyPanels() {
  const departments = await prisma.department.findMany({ include: { teams: true }, orderBy: { name: 'asc' } });
  const teams = departments.flatMap((d) => d.teams.map((t) => ({ name: t.name, department: d.name })));
  return { departments, teams };
}

// ADMINISTRATION IS NOT PUBLIC. This GET carried no guard, so any signed-in
// login — a recruiter, an accountant, a candidate — could read the company profile and its policies.
// It is guarded by the same feature its screen is now.
router.get('/company', requirePerm(null, 'administration', 'Company Setup', 'view'), async (req, res) => {
  let company = await prisma.company.findFirst();
  if (!company) {
    company = await prisma.company.create({
      data: { ...COMPANY_DEFAULTS, policies: JSON.stringify(COMPANY_POLICIES) },
    });
  }
  const { departments, teams } = await companyPanels();
  res.json(shapeCompany(company, departments, teams));
});

router.put('/company', requirePerm(null, 'administration', 'Company Setup', 'edit'), async (req, res) => {
  const { name, email, phone, hq, address } = req.body;
  let company = await prisma.company.findFirst();
  if (!company) company = await prisma.company.create({ data: { name: name || COMPANY_DEFAULTS.name } });
  const updated = await prisma.company.update({
    where: { id: company.id },
    data: { name, email, phone, hq, address },
  });
  await logAudit({ userId: req.user.id, action: 'Company setup updated', entity: 'Company', entityId: updated.id });
  const { departments, teams } = await companyPanels();
  res.json(shapeCompany(updated, departments, teams));
});

// ---- Notifications ----
// EACH PERSON SEES THEIR OWN. Every notification is addressed to a user
// (utils/notify.js drops any without one); a row with no owner is not
// "for everyone" — it is an orphan, and showing it to every login is how one
// requirement's pipeline news reached people who have nothing to do with it.
// Two modes on one path, so the header bell (NotificationBell.jsx) keeps its
// bare array of the latest 30:
//   no ?page          -> [notification]   (unchanged)
//   ?page=N           -> { rows, total, page, pageSize, channels }  — the
//                        Notifications screen: paged + filtered on the server
//                        (q, channel, from/to ISO dates). Still the caller's
//                        OWN rows only; filters can only narrow that.
const isoDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dayAfter = (s) => new Date(new Date(`${s}T00:00:00.000Z`).getTime() + 86400000);
function pageArgs(q, def = 25) {
  const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || def));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
function createdAtRange(q) {
  const range = {};
  if (isoDay(q.from)) range.gte = new Date(`${q.from}T00:00:00.000Z`);
  if (isoDay(q.to)) range.lt = dayAfter(q.to);
  return Object.keys(range).length ? range : null;
}
const shapeNotification = (n) => ({
  ...n,
  recipient: n.recipient || n.user?.name || 'Everyone',
  channel: n.channel || 'In-App',
  status: n.status || (n.read ? 'Read' : 'Delivered'),
});

// An email line's status is read against the master switch (utils/hrmsNotify.js displayStatus): never "waiting" when emails are OFF.
const withMailStatus = async (rows) => {
  if (!rows.some((n) => n.channel === 'Email')) return rows;
  const hn = require('../utils/hrmsNotify'); // eslint-disable-line global-require
  const s = await hn.getSettings();
  return rows.map((n) => ({ ...n, status: hn.displayStatus(n, s) || n.status }));
};

router.get('/notifications', async (req, res) => {
  // A TL / STL / Recruiter / HR login never gets a line about an agreement (utils/agreementPrivacy.js).
  const noAgreement = require('../utils/agreementPrivacy').notificationFilter(req.user); // eslint-disable-line global-require
  if (req.query.page !== undefined) {
    // rows hidden by a PAUSED announcement (utils/announcementPause.js) are left out
    const PH = require('../utils/announcementPause').PAUSED_HIDE; // eslint-disable-line global-require
    const own = noAgreement ? { AND: [{ userId: req.user.id }, noAgreement, PH] } : { AND: [{ userId: req.user.id }, PH] };
    const and = [own];
    const q = String(req.query.q || '').trim();
    if (q) and.push({ OR: [{ title: { contains: q } }, { message: { contains: q } }, { recipient: { contains: q } }] });
    const ch = String(req.query.channel || '');
    // Rows written before the channel column existed are In-App.
    if (ch) and.push(ch === 'In-App' ? { OR: [{ channel: 'In-App' }, { channel: null }] } : { channel: ch });
    const range = createdAtRange(req.query);
    if (range) and.push({ createdAt: range });
    const where = { AND: and };
    const { page, pageSize, skip, take } = pageArgs(req.query);
    const [rows, total, chans, unread] = await Promise.all([
      prisma.notification.findMany({
        where, include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, skip, take,
      }),
      prisma.notification.count({ where }),
      prisma.notification.groupBy({ by: ['channel'], where: own }),
      prisma.notification.count({ where: { ...own, read: false } }),
    ]);
    const channels = [...new Set(chans.map((c) => c.channel || 'In-App'))].sort();
    return res.json({ rows: await withMailStatus(rows.map(shapeNotification)), total, page, pageSize, channels, unread });
  }
  const notifications = await prisma.notification.findMany({
    where: { AND: [{ userId: req.user.id }, require('../utils/announcementPause').PAUSED_HIDE, ...(noAgreement ? [noAgreement] : [])] }, // eslint-disable-line global-require
    // Name only — never the password hash (hrms-24 §12).
    include: { user: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  // Recipient / Channel / Status are the prototype's Notifications columns.
  // Rows written before those columns existed fall back to the owning user,
  // the in-app channel, and the delivered/pending state we actually know.
  res.json(await withMailStatus(notifications.map((n) => ({
    ...n,
    recipient: n.recipient || n.user?.name || 'Everyone',
    channel: n.channel || 'In-App',
    status: n.status || (n.read ? 'Read' : 'Delivered'),
  }))));
});

// THE JOB-REQUEST POP-UP (user, 2026-10-09). The few notifications that must be
// seen on screen at once - a client's new job request, sent to the client's BDE
// and the BDE TL (utils/requirementRequest.js) - come back here, newest first,
// for the pop-up in the app shell (components/JobRequestPopup.jsx) to poll. A
// row stays here until ITS OWNER acknowledges it (PATCH /notifications/:id/read),
// so each person's pop-up is theirs alone, shows on their next login if they
// were away, and never doubles (one row per person per request).
router.get('/notifications/popups', async (req, res) => {
  const { POPUP_TITLE } = require('../utils/requirementRequest'); // eslint-disable-line global-require
  const rows = await prisma.notification.findMany({
    where: {
      userId: req.user.id, read: false, title: { startsWith: POPUP_TITLE },
      createdAt: { gt: new Date(Date.now() - 30 * 86400000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const idOf = (n) => (String(n.message || '').match(/\nOpen: \/requirements\/([^\s]+)\s*$/) || [])[1] || null;
  const reqs = await prisma.requirement.findMany({
    where: { id: { in: rows.map(idOf).filter(Boolean) } },
    select: { id: true, reqCode: true, title: true, openings: true, status: true, client: { select: { name: true } } },
  });
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const RA = require('../utils/requestAccept'); // eslint-disable-line global-require
  const stateById = new Map(await Promise.all(reqs.map(async (r) => [r.id, await RA.stateOf(r.id)])));
  const seen = new Set();
  const out = [];
  rows.forEach((n) => {
    const rid = idOf(n);
    const r = rid ? byId.get(rid) : null;
    if (!r || seen.has(r.id)) return;
    seen.add(r.id);
    out.push({
      requestState: stateById.get(r.id) || null,
      id: n.id, requirementId: r.id, reqCode: r.reqCode, client: (r.client && r.client.name) || n.title.slice(POPUP_TITLE.length),
      jobTitle: r.title, openings: r.openings || 1, status: r.status, createdAt: n.createdAt, path: `/requirements/${r.id}`,
    });
  });
  res.json(out);
});

router.patch('/notifications/:id/read', async (req, res) => {
  // Notifications are now pushed per-user from the ATS pipeline (see
  // utils/notify.js), so only their owner may mark one read. userId null is a
  // broadcast, readable by anyone.
  const existing = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.user.id) {
    return res.status(404).json({ error: 'Notification not found' });
  }
  const notification = await prisma.notification.update({ where: { id: req.params.id }, data: { read: true } });
  res.json(notification);
});

router.post('/notifications/read-all', async (req, res) => {
  await prisma.notification.updateMany({
    where: { read: false, userId: req.user.id },
    data: { read: true },
  });
  res.json({ ok: true });
});

// ---- Audit logs ----
// Two modes on one path:
//   no ?page    -> the latest 200 rows as a bare array (unchanged)
//   ?page=N     -> { rows, total, page, pageSize, facets } — the Audit Logs
//                  screen, paged and filtered on the server (4,000+ rows):
//                  q (action / entity / record id / values / field / actor),
//                  userId ('__system' = no user), action, entity,
//                  approvalStatus, from / to (ISO dates), sort (new | old).
//                  `facets` carries the option lists for the filter bar.
const AUDIT_USER = { select: { id: true, name: true, email: true, role: true } };
// A CSV the browser built itself (frontend utils/csv.js downloadCsv) is reported here, so no export escapes the Super Admin alert.
router.post('/hr-sensitive/client-export', async (req, res) => {
  if (!req.user.hrSuper) return res.status(204).end();
  const A = require('../utils/hrSensitiveAlert'); // eslint-disable-line global-require
  const b = req.body || {};
  const module = A.moduleOf(String(b.page || '/').split('?')[0]);
  await A.record({
    kind: 'export', module, what: `${module} ${String(b.name || 'file').replace(/.(csv|xlsx)$/i, '').replace(/[-_]+/g, ' ').slice(0, 60)}`.trim(), count: Number.isFinite(Number(b.rows)) ? Number(b.rows) : null,
    actorId: req.user.id, actorName: req.user.name || req.user.email, actorEmail: req.user.email, label: req.user.hrSuper.label || 'Internal HR',
    filters: 'none (built in the browser)', ip: require('../utils/clientIp').ipOf(req), // eslint-disable-line global-require
  });
  res.status(204).end();
});

// ---- HR SUPER ACCESS (founder, 2026-10-14; utils/hrSuper.js) ----------------------------------------------
// The list of logins that work as "Internal HR" (Super-Admin-equivalent minus the kept guards), the guards
// themselves, and the two switches. Only a REAL Super Admin or Admin changes it (also in utils/hrSuper.js GUARDS).
router.get('/hr-super-access', requirePerm(null, 'administration', 'Users', 'view'), async (req, res) => {
  const hrSuper = require('../utils/hrSuper'); // eslint-disable-line global-require
  const cfg = await hrSuper.settings();
  const ids = cfg.users.map((u) => u.id);
  const rows = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, include: { employee: { select: { employeeCode: true, department: true, designation: true, employmentStatus: true } } } }) : [];
  const roleHolders = await prisma.user.findMany({
    where: { OR: hrSuper.ROLE_FIELDS.map((f) => ({ [f]: hrSuper.ROLE_CODE })), id: { notIn: ids } },
    include: { employee: { select: { employeeCode: true, department: true, designation: true, employmentStatus: true } } },
  });
  const shape = (u, via) => ({ id: u.id, name: u.name, email: u.email, via, employeeCode: u.employee ? u.employee.employeeCode : null, department: u.employee ? u.employee.department : null, designation: u.employee ? u.employee.designation : null, employmentStatus: u.employee ? u.employee.employmentStatus : null, status: u.status });
  const mailCfg = await mailer.emailConfig().catch(() => ({ configured: false }));
  res.json({
    enabled: cfg.enabled, emailSuperAdmins: cfg.emailSuperAdmins, notifyAdmins: cfg.notifyAdmins,
    users: [...rows.map((u) => shape(u, 'list')), ...roleHolders.map((u) => shape(u, 'role'))],
    guards: hrSuper.guardList(), roleCode: hrSuper.ROLE_CODE, roleName: hrSuper.ROLE_NAME,
    canEdit: hrSuper.isRealTop(req.user),
    mail: { configured: !!mailCfg.configured, note: mailCfg.configured ? 'E-mail is set up: Super Admins also get an e-mail.' : 'E-mail is not set up yet: Super Admins get the bell notification only.' },
  });
});
router.put('/hr-super-access', requirePerm(null, 'administration', 'Users', 'edit'), async (req, res) => {
  const hrSuper = require('../utils/hrSuper'); // eslint-disable-line global-require
  if (!hrSuper.isRealTop(req.user)) return res.status(403).json({ error: 'Only a Super Admin or an Admin can give or take away Internal HR access.' });
  const cfg = await hrSuper.settings();
  const b = req.body || {};
  const next = { ...cfg, users: [...cfg.users] };
  if (b.enabled !== undefined) next.enabled = !!b.enabled;
  if (b.emailSuperAdmins !== undefined) next.emailSuperAdmins = !!b.emailSuperAdmins;
  if (b.notifyAdmins !== undefined) next.notifyAdmins = !!b.notifyAdmins;
  const added = [];
  for (const id of [].concat(b.add || [])) {
    // eslint-disable-next-line no-await-in-loop
    const u = await prisma.user.findUnique({ where: { id: String(id) }, include: { employee: { select: { employeeCode: true } } } });
    if (!u) return res.status(404).json({ error: 'That login was not found.' });
    if (['SUPER_ADMIN', 'ADMIN', 'CLIENT', 'CANDIDATE'].includes(u.role)) return res.status(400).json({ error: `${u.name} is already a Super Admin / Admin, or an outside login: nothing to give.` });
    if (u.id === req.user.id) return res.status(403).json({ error: 'You cannot change your own access.' });
    if (!next.users.some((x) => x.id === u.id)) {
      next.users.push({ id: u.id, name: u.name, employeeCode: u.employee ? u.employee.employeeCode : null, addedAt: new Date().toISOString(), addedBy: req.user.name });
      added.push(u);
    }
  }
  const removed = [];
  for (const id of [].concat(b.remove || [])) {
    const i = next.users.findIndex((x) => x.id === String(id));
    if (i >= 0) { removed.push(next.users[i]); next.users.splice(i, 1); }
  }
  const saved = await hrSuper.saveSettings(next, req.user);
  await hrSuper.ensureRole(req.user).catch(() => null);
  for (const u of added) await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Internal HR access given to ${u.name}`, entity: 'User', entityId: u.id, toValue: 'HR super access' });
  for (const u of removed) await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Internal HR access taken from ${u.name || u.id}`, entity: 'User', entityId: u.id, fromValue: 'HR super access' });
  if (added.length) {
    const sas = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'Active' }, select: { id: true } });
    await require('../utils/notify').notifyUsers(sas.map((x) => x.id), { // eslint-disable-line global-require
      title: 'Internal HR access was given', message: `${req.user.name || 'Someone'} gave ${added.map((u) => u.name).join(', ')} Internal HR access (everything a Super Admin can do except the guarded items).`, exceptUserId: req.user.id,
    });
  }
  res.json({ ok: true, enabled: saved.enabled, emailSuperAdmins: saved.emailSuperAdmins, notifyAdmins: saved.notifyAdmins, users: saved.users });
});

router.get('/audit', requirePerm(null, 'administration', 'Audit Logs', 'view'), async (req, res) => {
  if (req.query.page !== undefined) {
    const and = [];
    const q = String(req.query.q || '').trim();
    if (q) {
      and.push({
        OR: [
          { action: { contains: q } }, { entity: { contains: q } }, { entityId: { contains: q } },
          { fromValue: { contains: q } }, { toValue: { contains: q } }, { fieldLabel: { contains: q } },
          { field: { contains: q } }, { reason: { contains: q } }, { actorName: { contains: q } },
          { user: { is: { name: { contains: q } } } },
        ],
      });
    }
    const uid = String(req.query.userId || '');
    if (uid) and.push({ userId: uid === '__system' ? null : uid });
    if (req.query.action) and.push({ action: String(req.query.action) });
    if (req.query.entity) and.push({ entity: String(req.query.entity) });
    if (req.query.approvalStatus) and.push({ approvalStatus: String(req.query.approvalStatus) });
    const range = createdAtRange(req.query);
    if (range) and.push({ createdAt: range });
    const where = and.length ? { AND: and } : {};
    const { page, pageSize, skip, take } = pageArgs(req.query);
    const orderBy = { createdAt: req.query.sort === 'old' ? 'asc' : 'desc' };
    const [rows, total, byUser, byAction, byEntity, byApproval] = await Promise.all([
      prisma.auditLog.findMany({ where, include: { user: AUDIT_USER }, orderBy, skip, take }),
      prisma.auditLog.count({ where }),
      prisma.auditLog.groupBy({ by: ['userId'] }),
      prisma.auditLog.groupBy({ by: ['action'] }),
      prisma.auditLog.groupBy({ by: ['entity'] }),
      prisma.auditLog.groupBy({ by: ['approvalStatus'] }),
    ]);
    const ids = byUser.map((u) => u.userId).filter(Boolean);
    const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const users = people.map((u) => ({ value: u.id, label: u.name })).sort((a, b) => a.label.localeCompare(b.label));
    if (byUser.some((u) => !u.userId)) users.push({ value: '__system', label: 'System' });
    const sorted = (list, key) => list.map((r) => r[key]).filter(Boolean).sort((a, b) => a.localeCompare(b));
    return res.json({
      rows,
      total,
      page,
      pageSize,
      facets: {
        users,
        actions: sorted(byAction, 'action'),
        entities: sorted(byEntity, 'entity'),
        approvalStatuses: sorted(byApproval, 'approvalStatus'),
      },
    });
  }
  // The actor's name and email only. `user: true` sent every actor's bcrypt
  // hash and set-password token hash to the browser (hrms-24 §12 audit).
  const logs = await prisma.auditLog.findMany({ include: { user: AUDIT_USER }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json(logs);
});

/* ==========================================================================
   EMPLOYEE MANAGEMENT — MOVED to routes/employees.js.

   The whole surface (the list, its options, Add Employee, Create Login,
   Activate / Deactivate, Reset Password, Assign Roles, EDIT SCOPE and the
   View modal) is now /api/employees/management*, guarded by
   `hrms / Employee Management / <action>` and held to the caller''s own data
   scope, instead of `administration / Users` which only Super Admin and
   Admin hold. That guard is exactly what stopped a TL from seeing their own
   department''s employees on this screen.

   Nothing was copied: Administration -> Users links to Employee Management
   for Add Employee and for Edit Scope rather than carrying a second version.
   ========================================================================== */

/* ==========================================================================
   ORGANIZATION STRUCTURE  (prototype adminOrgStructureView, line 10486)

   The approval & escalation chain requests travel down — leave, attendance,
   alerts, issues. Drag to reorder; roles can be edited or paused, never
   deleted. Departments, Branches and Teams sit underneath it.
   ========================================================================== */
async function orgRoles() {
  let rows = await prisma.orgRole.findMany({ orderBy: { position: 'asc' } });
  if (!rows.length) {
    await prisma.$transaction(ORG_STRUCTURE_DEFAULT.map((r, i) => prisma.orgRole.create({ data: { ...r, position: i } })));
    rows = await prisma.orgRole.findMany({ orderBy: { position: 'asc' } });
  }
  return rows;
}

// ADMINISTRATION IS NOT PUBLIC. This GET carried no guard, so any signed-in
// login — a recruiter, an accountant, a candidate — could read the approval and escalation chain.
// It is guarded by the same feature its screen is now.
router.get('/org-structure', requirePerm(null, 'administration', 'Organization Structure', 'view'), async (req, res) => {
  // Organization Structure is read-only for a scoped Manager / Assistant
  // Manager (§15), and read-only is still scoped: they see their own branches.
  const allowedOrg = scopeDepartments(req.user);
  const [roles, departments] = await Promise.all([orgRoles(), prisma.department.findMany({
    where: allowedOrg === undefined ? {} : { name: { in: allowedOrg } },
    include: { teams: { orderBy: { name: 'asc' } } },
    orderBy: { name: 'asc' },
  })]);
  const branches = [...new Set((await prisma.employee.findMany({ select: { branch: true, location: true } }))
    .map((e) => e.branch || e.location).filter(Boolean))].sort();
  // Spec item 19 — what each role means for the approval chain, in plain
  // words, so the screen can say "In the approval chain" / "Paused" / "Not an
  // approver (below Employee)" next to every row.
  let chainOf = {};
  try {
    const lad = await require('../utils/approvalWorkflow').ladder();
    chainOf = Object.fromEntries(lad.levels.filter((l) => l.orgRoleId && !l.applicant).map((l) => [l.orgRoleId, {
      inChain: true, paused: !!l.paused, level: l.level, step: l.seq - 1,
    }]));
  } catch (err) { console.error('[org-structure] ladder', err.message); }
  res.json({
    chain: roles.map((r) => ({ id: r.id, ...(chainOf[r.id] || { inChain: false }) })),
    roles,
    departments: departments.map((d) => ({ id: d.id, name: d.name, parent: null })),
    branches: branches.map((name) => ({ name, location: name })),
    teams: departments.flatMap((d) => d.teams.map((t) => ({ id: t.id, name: t.name, department: d.name }))),
  });
});

router.post('/org-structure', requirePerm(null, 'administration', 'Organization Structure', 'create'), async (req, res) => {
  const { name, description } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A role name is required' });
  const rows = await orgRoles();
  // A NEW ROLE STARTS JUST BELOW SUPER ADMIN (spec item 19 — "when a role is
  // added it becomes available in the approval chain"). Appended at the
  // bottom it landed below "Employee", where nobody can approve anything.
  // Drag it to move it.
  const top = rows.findIndex((r) => r.system);
  const at = top >= 0 ? top + 1 : 0;
  const role = await prisma.$transaction(async (tx) => {
    for (const r of rows.slice(at)) {
      await tx.orgRole.update({ where: { id: r.id }, data: { position: r.position + 1 } }); // eslint-disable-line no-await-in-loop
    }
    return tx.orgRole.create({
      data: { name: String(name).trim(), description: (description && String(description).trim()) || '—', system: false, paused: false, position: at },
    });
  });
  await logAudit({ userId: req.user.id, action: 'Approval-chain role added', entity: 'OrgRole', entityId: role.id, toValue: role.name });
  res.status(201).json(role);
});

// REMOVE a role from the structure (spec item 19 — "when a role is removed it
// no longer appears"). System roles stay. Requests waiting on it right now
// move on to their next approver.
router.delete('/org-structure/:id', requirePerm(null, 'administration', 'Organization Structure', 'edit'), async (req, res) => {
  const existing = await prisma.orgRole.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  if (existing.system) return res.status(409).json({ error: 'Super Admin is the final approver and cannot be removed.' });
  await prisma.orgRole.delete({ where: { id: existing.id } });
  const rest = await prisma.orgRole.findMany({ orderBy: { position: 'asc' } });
  await prisma.$transaction(rest.map((r, i) => prisma.orgRole.update({ where: { id: r.id }, data: { position: i } })));
  await logAudit({ userId: req.user.id, action: 'Approval-chain role removed', entity: 'OrgRole', entityId: existing.id, fromValue: existing.name });
  let rerouted = { moved: 0, kept: 0 };
  try { rerouted = await require('../utils/approvalWorkflow').reroutePausedSteps(); } catch (err) { console.error('[org-structure] reroute', err.message); }
  res.json({ ok: true, rerouted });
});

// Drag-reorder: the client sends the whole chain in its new order. Declared
// before /:id so "reorder" is never read as a role id.
router.put('/org-structure/reorder', requirePerm(null, 'administration', 'Organization Structure', 'edit'), async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be an array of role ids' });
  const rows = await orgRoles();
  const known = new Set(rows.map((r) => r.id));
  if (order.length !== rows.length || order.some((id) => !known.has(id))) {
    return res.status(400).json({ error: 'order must list every role exactly once' });
  }
  await prisma.$transaction(order.map((id, i) => prisma.orgRole.update({ where: { id }, data: { position: i } })));
  const movedId = order.find((id, i) => rows[i] && rows[i].id !== id);
  if (movedId) {
    const moved = rows.find((r) => r.id === movedId);
    await logAudit({
      userId: req.user.id, action: 'Approval chain reordered', entity: 'OrgRole', entityId: moved.id,
      fromValue: `position ${rows.findIndex((r) => r.id === moved.id) + 1}`, toValue: `position ${order.indexOf(moved.id) + 1}`,
    });
  }
  res.json(await prisma.orgRole.findMany({ orderBy: { position: 'asc' } }));
});

router.put('/org-structure/:id', requirePerm(null, 'administration', 'Organization Structure', 'edit'), async (req, res) => {
  const { name, description, approveDays } = req.body;
  const existing = await prisma.orgRole.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  const role = await prisma.orgRole.update({
    where: { id: req.params.id },
    data: {
      name: name && String(name).trim() ? String(name).trim() : existing.name,
      description: description && String(description).trim() ? String(description).trim() : existing.description,
      approveDays: approveDays === undefined ? existing.approveDays : (approveDays === '' || approveDays === null ? null : Number(approveDays)),
    },
  });
  await logAudit({ userId: req.user.id, action: 'Approval-chain role edited', entity: 'OrgRole', entityId: role.id, fromValue: existing.name, toValue: 'Updated' });
  res.json(role);
});

// Pause / Resume — a paused role is skipped when a request escalates.
router.post('/org-structure/:id/toggle-pause', requirePerm(null, 'administration', 'Organization Structure', 'edit'), async (req, res) => {
  const existing = await prisma.orgRole.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  if (existing.system) return res.status(409).json({ error: 'A system role cannot be paused' });
  const role = await prisma.orgRole.update({ where: { id: req.params.id }, data: { paused: !existing.paused } });
  await logAudit({
    userId: req.user.id, action: `${role.paused ? 'Paused' : 'Resumed'} role in approval chain`,
    entity: 'OrgRole', entityId: role.id, fromValue: existing.paused ? 'Paused' : 'Active', toValue: role.paused ? 'Paused' : 'Active',
  });
  // Spec item 19 — a paused role is never an active approver: requests
  // waiting on it right now move on to their next approver.
  let rerouted = { moved: 0, kept: 0 };
  if (role.paused) {
    try { rerouted = await require('../utils/approvalWorkflow').reroutePausedSteps(); } catch (err) { console.error('[org-structure] reroute', err.message); }
  }
  res.json({ ...role, rerouted });
});

/* ==========================================================================
   INTEGRATIONS  (prototype integrationsView, line 10367)

   Two screens on their own tabs: the connection catalogue for every outside
   channel, and the Job Portal synchronisation with its own status, controls
   and sync log.

   Every channel except the Job Portal is Demo / Simulated — no external API is
   contacted, and the UI says so, exactly as the prototype does. The Job Portal
   is real: it is this app's own public careers site (routes/public.js).
   ========================================================================== */
async function integrationRow(id) {
  let row = await prisma.integration.findUnique({ where: { id } });
  if (!row) row = await prisma.integration.create({ data: { id } });
  return row;
}

// SECRETS NEVER LEAVE THE SERVER.
//
// publicValuesFor() (utils/integrationStore.js) returns the non-secret fields
// verbatim and replaces every credential field with a masked hint. This is the
// only shaping function the integration routes use, so there is no path by
// which a password or API key reaches a response body.
function shapeIntegration(channel, row) {
  const { values, secretHints, secretFields } = publicValuesFor(channel, row);
  return {
    id: channel.id, name: channel.name, group: channel.group, glyph: channel.glyph,
    desc: channel.desc, fields: channel.fields,
    // the form's helpers: greyed hints that are never values, dropdown choices, and which fields each provider shows (SMS Gateway)
    ...(channel.hints ? { hints: channel.hints } : {}), ...(channel.choices ? { choices: channel.choices } : {}), ...(channel.byProvider ? { byProvider: channel.byProvider } : {}),
    enabled: row ? row.enabled : false,
    state: row ? row.state : 'Not Connected',
    values,
    secretHints,
    secretFields,
    // Whether this channel really talks to an outside system. Everything
    // else on the screen is still Demo / Simulated and says so.
    live: LIVE_CHANNELS.includes(channel.id),
    // Save & Post: a job board gets its own details panel on the card.
    jobBoard: JOB_BOARD_CHANNELS.includes(channel.id),
    lastSync: row && row.lastSync ? new Date(row.lastSync).toLocaleString() : null,
    lastTest: row && row.lastTest ? new Date(row.lastTest).toLocaleString() : null,
    lastTestResult: row ? row.lastTestResult : null,
    recordsSynced: row ? row.recordsSynced : 0,
    recordsFailed: row ? row.recordsFailed : 0,
    error: row ? row.error : null,
  };
}

// The prototype's detBool(): a stable, deterministic pass/fail per channel, so
// a simulated test answers the same way every time.
function detBool(seed, pct) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 1000;
  return h % 100 < pct;
}

// "Failed" counts RECORDS still failing — a requirement push or a portal
// application that went wrong (rows with a recordRef) since the last full sync
// that worked end to end; that sync re-pushes every live requirement and
// re-pulls 90 days of applications, so it supersedes anything older. A whole
// run that failed because the portal was down is not a failed record: it is
// reported as `portalError` (the latest run's failure, until a good run).
// Before this, every startup sync with the portal switched off (one per
// nodemon restart) added one to a "failed" badge that never went down.
async function jobPortalStats() {
  const lastGood = await prisma.syncLog.findFirst({
    where: { entity: 'Requirements', status: 'Success', reason: { startsWith: 'Job Portal sync' } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  const since = lastGood ? { createdAt: { gt: lastGood.createdAt } } : {};
  const [lastRun, failedRows, failedReqs] = await Promise.all([
    prisma.syncLog.findFirst({
      where: { entity: 'Requirements', reason: { startsWith: 'Job Portal sync' } },
      orderBy: { createdAt: 'desc' }, select: { status: true, reason: true, createdAt: true },
    }),
    prisma.syncLog.findMany({ where: { status: 'Failed', recordRef: { not: null }, ...since }, distinct: ['recordRef'], select: { recordRef: true } }),
    // A published, live requirement the portal has not accepted.
    prisma.requirement.findMany({ where: { portalPublished: true, portalSyncStatus: 'Failed', status: { in: REQUIREMENT_LIVE_STATUSES } }, select: { id: true } }),
  ]);
  const failedRecords = new Set([...failedRows.map((r) => r.recordRef), ...failedReqs.map((r) => r.id)]);
  const portalError = lastRun && lastRun.status === 'Failed' && / failed: /.test(lastRun.reason || '')
    ? { reason: lastRun.reason, at: lastRun.createdAt } : null;
  const [candidates, applications, requirements, needsMapping] = await Promise.all([
    prisma.candidate.count({ where: { source: 'Job Portal' } }),
    prisma.application.count({ where: { candidate: { source: 'Job Portal' } } }),
    prisma.requirement.count({ where: { status: { in: REQUIREMENT_LIVE_STATUSES }, postingSources: { contains: 'Job Portal' } } }),
    // A portal candidate who never landed on a requirement still needs mapping.
    prisma.candidate.count({ where: { source: 'Job Portal', applications: { none: {} } } }),
  ]);
  return { candidates, applications, requirements, needsMapping, failed: failedRecords.size, portalError };
}

// ONE SET OF INTEGRATIONS (founder 2026-10-30: "both application is same"): Omni-Channel (Green Start) uses TeamLink's Email / SMS / WhatsApp
// (utils/greenStartIntegrations.js). Every save, connect or disconnect of those three channels here is passed on to Omni-Channel a few seconds later.
const GSI = require('../utils/greenStartIntegrations');
router.use('/integrations/:id', (req, res, next) => {
  if (req.method !== 'GET' && ['email', 'sms', 'whatsapp', 'social'].includes(req.params.id)) {
    res.on('finish', () => { if (res.statusCode < 300) GSI.schedule(`${req.params.id} changed`); });
  }
  next();
});
// Administration > Integrations > Omni-Channel: what Omni-Channel got from TeamLink last, and everything Omni-Channel has connected itself.
router.get('/integrations-omni-channel', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const want = await GSI.teamlinkChannels();
  const teamlink = Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v.body ? { ready: true } : { ready: false, words: v.none }]));
  let connections = null; let connectionsError = null;
  try { connections = await GSI.connections(); } catch (err) { connectionsError = err.message; }
  res.json({ teamlink, last: await GSI.lastResult(), connections, connectionsError });
});
router.post('/integrations-omni-channel/sync', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  res.json(await GSI.sync({ force: true, why: 'Send to Omni-Channel now', by: req.user.name }));
});

// SOCIAL MEDIA = FACEBOOK PAGE (founder 2026-10-30). The Page ID + Page access token typed on the Social Media card are copied into the job-posting
// connection (jobPublish/credentials: portal "facebook"), checked with Facebook at once (read-only, nothing is posted) and - through
// utils/greenStartIntegrations.js - handed to Omni-Channel. The card says Connected ONLY when Facebook accepted the token.
async function applySocial(user, { how = 'Saved', save = true } = {}) {
  const CR = require('../jobPublish/credentials'); // eslint-disable-line global-require
  const cfg = await readConfig('social');
  if (cfg.missingKey) return { ok: false, status: 400, words: NO_KEY_MESSAGE };
  const pageId = String(cfg.values['Facebook Page ID'] || '').trim();
  const token = String(cfg.values['Facebook Page access token'] || '').trim();
  if (!pageId || !token) return { ok: false, status: 400, words: 'Type both the Facebook Page ID and the Page access token, then Save.' };
  // a plain Test does not re-save (that would rewrite the job-posting login and its audit row each time) unless the job-posting copy is missing or different
  const have = save ? { ok: false } : await CR.read('facebook');
  if (save || !have.ok || have.username !== pageId || have.password !== token) {
    const saved = await CR.save('facebook', { username: pageId, password: token }, user);
    if (saved.error) return { ok: false, status: saved.status || 400, words: saved.error };
  }
  const checked = await CR.requestVerify('facebook', user); // an API portal: answered at once (read-only call, nothing posted)
  if (checked.error) return { ok: false, status: checked.status || 400, words: checked.error };
  const r = checked.result;
  const words = r.ok ? (r.summary || 'Facebook accepted the Page and the token.') : (r.summary || 'Facebook did not accept it.');
  const row = await prisma.integration.update({
    where: { id: 'social' },
    data: r.ok
      ? { state: 'Connected', connected: true, enabled: true, connectedAt: new Date(), error: null, lastTest: new Date(), lastTestResult: words.slice(0, 480) }
      : { state: 'Not Connected', connected: false, error: words.slice(0, 480), lastTest: new Date(), lastTestResult: words.slice(0, 480) },
  });
  await recordEvent('social', { action: r.ok ? how : `${how} - not accepted by Facebook`, by: user.name, result: words.slice(0, 480) });
  await logAudit({ userId: user.id, action: 'Facebook Page connection checked', entity: 'Integration', entityId: 'social', toValue: r.ok ? 'Connected' : 'Not connected' });
  return { ok: r.ok, status: r.ok ? 200 : 422, words, row };
}

router.get('/integrations', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const rows = await prisma.integration.findMany();
  const channels = INTEGRATION_CATALOG.map((c) => shapeIntegration(c, rows.find((r) => r.id === c.id)));
  // Biometric: the state is the device's heartbeat, never the stored flag.
  const bioChannel = channels.find((c) => c.id === 'biometric');
  if (bioChannel) {
    const device = await firstDevice();
    bioChannel.state = device ? bio.deviceState(device).state : 'Not Connected';
    bioChannel.device = shapeDevice(device);
  }
  res.json({
    groups: INTEGRATION_GROUPS,
    channels,
    connected: channels.filter((c) => c.state === 'Connected').length,
    total: channels.length,
    jobPortal: await jobPortalStats(),
  });
});

router.get('/integrations/job-portal', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const [stats, log, row] = await Promise.all([
    jobPortalStats(),
    prisma.syncLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    integrationRow('jobportal'),
  ]);
  res.json({
    stats,
    status: row.state === 'Connected' ? 'Connected' : 'Not Connected',
    lastSync: row.lastSync ? new Date(row.lastSync).toLocaleString() : '—',
    lastSyncResult: stats.portalError ? 'Last run failed — see Sync Logs' : (stats.failed ? 'Completed with errors' : 'Synced'),
    syncLog: log.map((l) => ({
      id: l.id,
      date: new Date(l.createdAt).toLocaleString(),
      entity: l.entity,
      status: l.status,
      reason: l.reason,
    })),
  });
});

// The Sync Logs table, paged and filtered on the server (additive — the
// job-portal payload above still carries its latest 50 as `syncLog`):
//   GET /integrations/job-portal/logs?status=&entity=&q=&from=&to=&page=&pageSize=
//   -> { rows: [{ id, date, createdAt, entity, status, reason }], total, page, pageSize, entities, statuses }
router.get('/integrations/job-portal/logs', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const and = [];
  if (req.query.status) and.push({ status: String(req.query.status) });
  if (req.query.entity) and.push({ entity: String(req.query.entity) });
  const q = String(req.query.q || '').trim();
  if (q) and.push({ OR: [{ reason: { contains: q } }, { recordRef: { contains: q } }, { entity: { contains: q } }] });
  const range = createdAtRange(req.query);
  if (range) and.push({ createdAt: range });
  const where = and.length ? { AND: and } : {};
  const { page, pageSize, skip, take } = pageArgs(req.query);
  const [rows, total, ents, stats] = await Promise.all([
    prisma.syncLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.syncLog.count({ where }),
    prisma.syncLog.groupBy({ by: ['entity'] }),
    prisma.syncLog.groupBy({ by: ['status'] }),
  ]);
  res.json({
    rows: rows.map((l) => ({
      id: l.id, date: new Date(l.createdAt).toLocaleString(), createdAt: l.createdAt,
      entity: l.entity, status: l.status, reason: l.reason,
    })),
    total,
    page,
    pageSize,
    entities: ents.map((e) => e.entity).filter(Boolean).sort(),
    statuses: stats.map((e) => e.status).filter(Boolean).sort(),
  });
});

// Sync — for the Job Portal this really re-counts what has come across from
// the public careers site and writes a log row. No external API is called.
router.post('/integrations/job-portal/sync', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  // The real two-way sync with the Job Portal app first (utils/jobPortalBridge.js),
  // then the counts below re-read what has come across.
  const portal = await require('../utils/jobPortalBridge').fullSync({ actor: req.user.name });
  const stats = await jobPortalStats();
  const synced = stats.candidates + stats.applications;
  const row = await integrationRow('jobportal');
  await prisma.integration.update({
    where: { id: 'jobportal' },
    data: {
      state: 'Connected', connected: true, enabled: true, lastSync: new Date(),
      recordsSynced: synced, recordsFailed: stats.failed,
      error: stats.failed ? `${stats.failed} record(s) could not be synced.` : null,
    },
  });
  await prisma.syncLog.create({
    data: { entity: 'Candidates', status: 'Success', reason: `${stats.candidates} candidate(s), ${stats.applications} application(s) read from the Job Portal` },
  });
  await recordEvent('jobportal', {
 action: 'Sync Now', by: req.user.name,
      result: stats.failed ? 'Completed with errors' : 'Completed',
      synced, failed: stats.failed, entities: (SYNC_ENTITIES.jobportal || []).join(', '),
    });
  await logAudit({ userId: req.user.id, action: 'Integration sync', entity: 'Integration', entityId: 'jobportal', toValue: `${synced} synced / ${stats.failed} failed` });
  res.json({ ok: true, synced, failed: stats.failed, previousState: row.state, portal });
});

router.post('/integrations/job-portal/log/:id/retry', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const entry = await prisma.syncLog.findUnique({ where: { id: req.params.id } });
  if (!entry) return res.status(404).json({ error: 'Log entry not found' });
  if (entry.status !== 'Failed') return res.status(400).json({ error: 'Only a failed entry can be retried.' });
  // A REAL retry. (It used to mark the row "Retried successfully" without
  // sending anything.) One requirement push -> push that requirement again;
  // anything else (a whole run, a portal application) -> a full sync, which
  // re-pushes every live requirement and re-pulls the portal's applications.
  // The row is marked resolved only when the retry really worked.
  const bridge = require('../utils/jobPortalBridge');
  let ok;
  let why;
  if (entry.entity === 'Requirements' && entry.recordRef) {
    const r = await bridge.pushRequirement(entry.recordRef);
    ok = !!r.ok;
    why = r.ok ? 'requirement pushed to the Job Portal' : (r.error || r.skipped || 'push failed');
  } else {
    const r = await bridge.fullSync({ actor: req.user.name });
    ok = r.ok && !r.failed && !r.errors.length;
    why = r.ok ? `${r.jobs} requirement(s) live, ${r.failed} failed, ${r.errors.length} problem(s)` : r.error;
  }
  if (!ok) return res.status(502).json({ error: `Retry did not work: ${String(why || '').replace(/\s+/g, ' ').trim().slice(0, 300)}` });
  const updated = await prisma.syncLog.update({
    where: { id: req.params.id },
    data: { status: 'Success', reason: `Resolved by retry (${new Date().toLocaleString()}, ${why}). Was: ${entry.reason || ''}`.slice(0, 1000) },
  });
  await logAudit({ userId: req.user.id, action: 'Sync record retried', entity: 'SyncLog', entityId: entry.id, fromValue: entry.status, toValue: 'Success' });
  res.json(updated);
});

router.get('/integrations/:id/history', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
  // ?limit (additive, default 25, max 200) lets the History modal filter a longer run.
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const events = await prisma.integrationEvent.findMany({ where: { integrationId: req.params.id }, orderBy: { createdAt: 'desc' }, take: limit });
  res.json({
    channel: channel.name,
    live: LIVE_CHANNELS.includes(channel.id),
    history: events.map((e) => ({
      at: new Date(e.createdAt).toLocaleString(), action: e.action, by: e.by,
      result: e.result, synced: e.synced, failed: e.failed, entities: e.entities,
    })),
  });
});

/* --------------------------------------------------------------------------
   BIOMETRIC DEVICE — REAL. The eSSL unit pushes to /iclock (routes/iclock.js);
   utils/biometricDevice.js holds the protocol. One device is configured here.
   Its status is read from lastSeenAt (the device's heartbeat) — never stored
   as "Connected" by pressing a button.
   -------------------------------------------------------------------------- */
async function firstDevice() {
  return prisma.biometricDevice.findFirst({ orderBy: { createdAt: 'asc' } });
}

function shapeDevice(d) {
  if (!d) return null;
  const st = bio.deviceState(d);
  const { model } = bio.splitVendor(d.vendor);
  return {
    id: d.id, vendor: d.vendor, model, protocol: d.protocol, serialNumber: d.serialNumber,
    endpoint: d.endpoint, port: d.port, status: d.status,
    state: st.state, connected: st.connected,
    lastSeenAt: d.lastSeenAt, lastSeenIp: d.lastSeenIp, lastRequest: d.lastRequest,
    info: bio.parseInfo(d.deviceInfo),
    punchesReceived: d.punchesReceived, lastPunchAt: d.lastPunchAt,
    heartbeatWindowSeconds: Math.round(bio.HEARTBEAT_FRESH_MS / 1000),
    updatedAt: d.updatedAt,
  };
}

// Save & Connect for the biometric channel: validates and stores the device.
async function saveBiometric(req, res, channel) {
  const v = req.body.values || {};
  const vendor = String(v.Vendor || '').trim().slice(0, 120);
  const serialNumber = String(v.Serial || '').trim();
  const endpoint = String(v.Endpoint || '').trim();
  const status = String(v.Status || 'Active').trim();
  const errors = [];
  if (!vendor) errors.push('Vendor is required.');
  if (!/^[A-Za-z0-9-]{4,40}$/.test(serialNumber)) errors.push('Serial must be the device serial number (letters and digits, e.g. NFZ8250204996).');
  let url = null;
  try { url = new URL(endpoint); } catch { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) errors.push('Endpoint must be a full http:// or https:// address, e.g. http://72.61.233.104:8080/iclock.');
  else if (!/\/iclock\/?$/i.test(url.pathname)) errors.push('Endpoint must end in /iclock — that is the path the device calls.');
  if (!bio.DEVICE_STATUSES.includes(status)) errors.push(`Status must be one of: ${bio.DEVICE_STATUSES.join(', ')}.`);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const before = await firstDevice();
  const data = {
    vendor, protocol: bio.splitVendor(vendor).protocol, serialNumber,
    endpoint: endpoint.replace(/\/+$/, ''), port: bio.portOf(endpoint), status, updatedById: req.user.id,
  };
  let device;
  if (before) {
    // A different serial is a different device: its heartbeat starts over.
    const reset = before.serialNumber !== serialNumber ? { lastSeenAt: null, lastSeenIp: null, lastRequest: null, deviceInfo: null, attlogStamp: null } : {};
    device = await prisma.biometricDevice.update({ where: { id: before.id }, data: { ...data, ...reset } });
  } else {
    device = await prisma.biometricDevice.create({ data: { ...data, createdById: req.user.id } });
  }
  const written = await writeValues(channel.id, { Vendor: vendor, Serial: serialNumber, Endpoint: data.endpoint, Status: status });
  const st = bio.deviceState(device);
  await integrationRow(channel.id);
  const row = await prisma.integration.update({
    where: { id: channel.id },
    data: { values: JSON.stringify(written.values), enabled: status === 'Active', connected: st.connected, state: st.state, connectedAt: new Date(), error: null },
  });
  await recordEvent(channel.id, { action: 'Connected', by: req.user.name, result: `Device ${serialNumber} saved — ${st.state}` });
  await logAudit({
    userId: req.user.id, action: 'Biometric device configured', entity: 'BiometricDevice', entityId: device.id,
    fromValue: before ? `${before.vendor} · ${before.serialNumber} · ${before.endpoint} · ${before.status}` : null,
    toValue: `${device.vendor} · ${device.serialNumber} · ${device.endpoint} · ${device.status}`,
  });
  return res.json({ ...shapeIntegration(channel, row), state: st.state, device: shapeDevice(device) });
}

async function setBiometricStatus(req, res, channel, status) {
  const device = await firstDevice();
  if (!device) return res.status(400).json({ error: 'Add the device first — open Configure for Biometric / Attendance Device.' });
  const next = await prisma.biometricDevice.update({ where: { id: device.id }, data: { status, updatedById: req.user.id } });
  const st = bio.deviceState(next);
  await integrationRow(channel.id);
  const row = await prisma.integration.update({ where: { id: channel.id }, data: { enabled: status === 'Active', connected: st.connected, state: st.state } });
  await recordEvent(channel.id, { action: status === 'Active' ? 'Connected' : 'Disconnected', by: req.user.name, result: `Device ${status} — ${st.state}` });
  await logAudit({ userId: req.user.id, action: `Biometric device ${status === 'Active' ? 'activated' : 'deactivated'}`, entity: 'BiometricDevice', entityId: device.id, fromValue: device.status, toValue: status });
  return res.json({ ...shapeIntegration(channel, row), state: st.state, device: shapeDevice(next) });
}

// Device users whose PIN is EXACTLY an employee's code (e.g. PIN "TL473" and
// employee TL473) where neither side is linked yet. Only an exact, case-
// sensitive match is offered — nothing is guessed from names.
async function codeMatches(device) {
  if (!device) return [];
  const [users, linked] = await Promise.all([
    prisma.biometricDeviceUser.findMany({ where: { deviceSerial: device.serialNumber } }),
    prisma.employee.findMany({ where: { biometricPin: { not: null } }, select: { biometricPin: true } }),
  ]);
  const linkedPins = new Set(linked.map((e) => e.biometricPin));
  const open = users.filter((u) => !linkedPins.has(u.pin));
  if (!open.length) return [];
  const employees = await prisma.employee.findMany({
    where: { employeeCode: { in: open.map((u) => u.pin) }, biometricPin: null },
    select: { id: true, name: true, employeeCode: true, department: true },
  });
  const byCode = new Map(employees.map((e) => [e.employeeCode, e]));
  return open
    .filter((u) => byCode.has(u.pin))
    .map((u) => {
      const e = byCode.get(u.pin);
      return { pin: u.pin, deviceName: u.name, employeeId: e.id, employeeName: e.name, employeeCode: e.employeeCode, department: e.department };
    })
    .sort((a, b) => a.pin.localeCompare(b.pin));
}

// The device card: live status, what came in, and PINs still waiting for an employee.
router.get('/integrations/biometric/status', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const device = await firstDevice();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const [unmapped, users, mapped, recent, todayCount, total] = await Promise.all([
    prisma.biometricPunchLog.groupBy({ by: ['pin'], where: { employeeId: null }, _count: { _all: true }, _max: { punchAt: true } }),
    prisma.biometricDeviceUser.findMany(),
    prisma.employee.findMany({ where: { biometricPin: { not: null } }, select: { id: true, name: true, employeeCode: true, department: true, biometricPin: true }, orderBy: { name: 'asc' } }),
    prisma.biometricPunchLog.findMany({ orderBy: [{ punchAt: 'desc' }], take: 15 }),
    prisma.biometricPunchLog.count({ where: { punchAt: { startsWith: todayStr } } }),
    prisma.biometricPunchLog.count(),
  ]);
  const nameOfPin = new Map(users.map((u) => [u.pin, u.name]));
  const empById = new Map(mapped.map((e) => [e.id, e]));
  const matches = await codeMatches(device);
  const matchOfPin = new Map(matches.map((m) => [m.pin, m]));
  const waitingOfPin = new Map(unmapped.map((u) => [u.pin, u._count._all]));
  res.json({
    device: shapeDevice(device),
    counts: { today: todayCount, total, unmappedPins: unmapped.length },
    unmapped: unmapped
      .map((u) => ({
        pin: u.pin, deviceName: nameOfPin.get(u.pin) || null, punches: u._count._all, lastPunchAt: u._max.punchAt,
        suggestedEmployeeId: matchOfPin.has(u.pin) ? matchOfPin.get(u.pin).employeeId : null,
      }))
      .sort((a, b) => String(b.lastPunchAt).localeCompare(String(a.lastPunchAt))),
    codeMatches: matches.map((m) => ({ ...m, waitingPunches: waitingOfPin.get(m.pin) || 0 })),
    mapped: mapped.map((e) => ({ ...e, deviceName: nameOfPin.get(e.biometricPin) || null })),
    recent: recent.map((l) => {
      const e = l.employeeId ? empById.get(l.employeeId) : null;
      return { pin: l.pin, punchAt: l.punchAt, statusCode: l.statusCode, verifyCode: l.verifyCode, employee: e ? `${e.name} (${e.employeeCode})` : null, deviceName: nameOfPin.get(l.pin) || null };
    }),
    unknownDevices: bio.listUnknown(),
    userQuery: device ? bio.commandStatus(device.serialNumber) : null,
    deviceUsers: device ? users.filter((u) => u.deviceSerial === device.serialNumber).length : 0,
  });
});

// Ask the device for its full user list; it goes out on the next heartbeat.
router.post('/integrations/biometric/fetch-users', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const device = await firstDevice();
  if (!device) return res.status(400).json({ error: 'Add the device first.' });
  const cmd = bio.queueUserQuery(device.serialNumber);
  await recordEvent('biometric', { action: 'Fetch users', by: req.user.name, result: `Queued — goes to the device on its next heartbeat (command ${cmd.id})` });
  return res.json({ ok: true, command: bio.commandStatus(device.serialNumber) });
});

// Link every exact code match in one go (the list shown on the card). Each is
// re-checked here, so a PIN linked in the meantime is skipped, not doubled.
router.post('/integrations/biometric/link-matches', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const device = await firstDevice();
  const matches = await codeMatches(device);
  let linked = 0;
  let applied = 0;
  for (const m of matches) {
    // eslint-disable-next-line no-await-in-loop
    const taken = await prisma.employee.findFirst({ where: { biometricPin: m.pin }, select: { id: true } });
    if (taken) continue;
    // eslint-disable-next-line no-await-in-loop
    await prisma.employee.update({ where: { id: m.employeeId }, data: { biometricPin: m.pin } });
    // eslint-disable-next-line no-await-in-loop
    applied += await bio.applyPin(m.pin, m.employeeId);
    linked += 1;
  }
  await logAudit({ userId: req.user.id, action: 'Biometric PINs linked by employee code', entity: 'BiometricDevice', entityId: device ? device.id : null, toValue: `${linked} linked, ${applied} waiting punch(es) applied` });
  return res.json({ ok: true, linked, applied });
});

// Map a device PIN to an employee (or clear it). Waiting punches are applied.
router.put('/integrations/biometric/map', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const pin = String(req.body.pin || '').trim();
  const employeeId = req.body.employeeId ? String(req.body.employeeId) : null;
  if (!/^[A-Za-z0-9]{1,24}$/.test(pin)) return res.status(400).json({ error: 'PIN must be the device user ID (letters and digits).' });
  if (!employeeId) {
    const holders = await prisma.employee.findMany({ where: { biometricPin: pin }, select: { id: true, name: true } });
    await prisma.employee.updateMany({ where: { biometricPin: pin }, data: { biometricPin: null } });
    await logAudit({ userId: req.user.id, action: 'Biometric PIN unmapped', entity: 'Employee', entityId: holders.map((h) => h.id).join(',') || null, fromValue: pin });
    return res.json({ ok: true, unmapped: holders.length });
  }
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, name: true, biometricPin: true } });
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const other = await prisma.employee.findFirst({ where: { biometricPin: pin, NOT: { id: employeeId } }, select: { name: true } });
  if (other) return res.status(409).json({ error: `PIN ${pin} is already mapped to ${other.name}. Clear that first.` });
  await prisma.employee.update({ where: { id: employeeId }, data: { biometricPin: pin } });
  const applied = await bio.applyPin(pin, employeeId);
  await logAudit({ userId: req.user.id, action: 'Biometric PIN mapped', entity: 'Employee', entityId: employeeId, fromValue: employee.biometricPin, toValue: `${pin} (${applied} waiting punch(es) applied)` });
  return res.json({ ok: true, applied });
});

// Save & Connect.
//
// Credentials go through utils/integrationStore.js: secret fields are
// AES-256-GCM encrypted with the key in INTEGRATION_SECRET_KEY before they
// touch the database, and a blank secret box means "leave the stored one
// alone" (the modal never receives the plaintext, so blank cannot mean erase).
// Nothing here logs a value — the audit row records only that the channel was
// configured.
router.put('/integrations/:id/configure', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
  if (channel.id === 'whatsapp-qr') return res.status(400).json({ error: 'Set up the QR-link prototype on Integrations > WhatsApp & SMS (it needs the "I understand" tick).' });
  if (channel.id === 'biometric') return saveBiometric(req, res, channel);
  let written;
  try {
    written = await writeValues(channel.id, req.body.values || {});
  } catch (err) {
    if (err && err.code === 'NO_SECRET_KEY') return res.status(400).json({ error: NO_KEY_MESSAGE });
    throw err;
  }
  if (!written.filled) return res.status(400).json({ error: 'Enter at least one credential to connect this channel.' });
  await integrationRow(channel.id);
  if (channel.id === 'social') {
    // keep what was typed (nothing typed is lost), then ask Facebook; Connected only if Facebook says yes
    await prisma.integration.update({ where: { id: 'social' }, data: { values: JSON.stringify(written.values) } });
    const r = await applySocial(req.user);
    const row = r.row || await integrationRow('social');
    if (!r.ok) return res.status(r.status).json({ ...shapeIntegration(channel, row), error: `Saved, but Facebook is NOT connected: ${r.words}`, saved: true });
    return res.json({ ...shapeIntegration(channel, row), message: 'Facebook Page connected. Omni-Channel gets the same Page in a few seconds. Posting jobs to the Page stays OFF until an Admin switches it on (Postings).' });
  }
  // SMS (founder 2026-10-27): the settings are checked here, on the server, and the channel is switched on ONLY when they pass.
  // With a problem the values stay saved (nothing typed is lost) but the channel stays off and the screen lists what to fix.
  if (channel.id === 'sms') {
    // the new values first (the check reads what is stored), then the check
    const SG = require('../utils/smsGateway'); // eslint-disable-line global-require
    const before = await SG.smsConfig({ ignoreSwitch: true });
    await prisma.integration.update({ where: { id: channel.id }, data: { values: JSON.stringify(written.values) } });
    let now = await SG.smsConfig({ ignoreSwitch: true });
    if (now.providerInferred && now.provider === 'SMSGW') {
      // the Provider box still said MSG91 while the SMS Push Platform login was filled in: store what it really is
      written = await writeValues(channel.id, { [SMS_FIELDS.provider]: 'SMS Push Platform' });
      await prisma.integration.update({ where: { id: channel.id }, data: { values: JSON.stringify(written.values) } });
      now = await SG.smsConfig({ ignoreSwitch: true });
    }
    const pk = (c) => (c.push ? [c.provider, c.push.url, c.push.user, c.push.pass, c.push.pe, c.sender].join('|') : c.provider);
    if (pk(before) !== pk(now)) await SG.forgetProof();
    const problems = now.problems;
    if (problems.length) {
      const off = await prisma.integration.update({ where: { id: channel.id }, data: { values: JSON.stringify(written.values), enabled: false, connected: false, state: 'Not Connected', error: problems.join(' ').slice(0, 480) } });
      await recordEvent(channel.id, { action: 'Saved - not switched on', by: req.user.name, result: problems.join(' ').slice(0, 480) });
      await logAudit({ userId: req.user.id, action: 'Integration saved (validation failed)', entity: 'Integration', entityId: channel.id, toValue: `${problems.length} problem(s)` });
      return res.status(422).json({ ...shapeIntegration(channel, off), error: `Saved, but SMS is NOT switched on - fix this first: ${problems.join(' ')}`, problems, saved: true });
    }
  }
  const row = await prisma.integration.update({
    where: { id: channel.id },
    data: {
      values: JSON.stringify(written.values),
      enabled: true,
      connected: true,
      state: 'Connected',
      connectedAt: new Date(),
      error: null,
    },
  });
  const live = LIVE_CHANNELS.includes(channel.id);
  if (channel.id === 'email') {
    // New credentials: drop the cached SMTP connection, and let the rows that
    // were held as "recorded, not transmitted" queue up for real sending.
    mailer.resetTransport();
    await mailWorker.requeueHeldMessages();
    mailWorker.kick();
  }
  if (channel.id === 'ai-claude') aiAgent.resetClient();
  if (channel.id === 'sms' || channel.id === 'whatsapp') {
    // Stage-change texts recorded in the last day can go out now.
    await mailWorker.requeueHeldMessages(channel.id === 'sms' ? 'SMS' : 'WhatsApp');
    mailWorker.kick();
  }
  await recordEvent(channel.id, {
 action: 'Connected', by: req.user.name,
      result: live ? 'Credentials saved (encrypted at rest)' : 'OK (Demo)',
    });
  await logAudit({ userId: req.user.id, action: 'Integration configured', entity: 'Integration', entityId: channel.id, toValue: 'Connected' });
  if (channel.id === 'whatsapp') {
    // THE TOKEN WAS JUST SAVED: ask Meta what it thinks of it, and re-check every number that reads it. "Connected" is only true if Meta says so.
    let waCheck = null; let shown = row;
    try {
      const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
      const wa = require('../utils/whatsappCloud'); // eslint-disable-line global-require
      const r = await WN.afterLegacyTokenChange(req.user);
      const parts = [];
      let rejected = false; let why = '';
      if (r.noList) {
        const t = await wa.testConnection();
        rejected = !t.ok && /\b(401|190)\b|token/i.test(String(t.result || ''));
        why = t.result || '';
        parts.push(t.ok ? `Meta accepted it. ${t.result}` : `Meta did not accept it. ${t.result}`);
      } else {
        const okL = r.checked.filter((c) => c.code === 'connected' || c.code === 'verification_required' || c.code === 'test_mode').map((c) => c.label);
        const badL = r.checked.filter((c) => c.code === 'disconnected');
        rejected = badL.some((c) => c.authFailed);
        why = (badL.find((c) => c.authFailed) || {}).text || '';
        if (okL.length) parts.push(`Meta accepted it for: ${okL.join(', ')}.`);
        if (badL.length) parts.push(`Meta did not accept it for: ${badL.map((c) => c.label).join(', ')}.`);
        const own = r.ownToken.filter((o) => !o.sameToken);
        if (own.length) parts.push(`Not changed (they keep their own token): ${own.map((o) => `${o.label}${o.legacyWorks ? ' (the new token works for it: edit the number and choose "The shared token")' : ''}`).join(', ')}.`);
      }
      shown = await prisma.integration.update({ where: { id: 'whatsapp' }, data: rejected ? { state: 'Token rejected by Meta', error: String(why).slice(0, 300) } : { state: 'Connected', error: null } });
      waCheck = { rejected, summary: `WhatsApp saved. ${parts.join(' ')}`.trim() };
    } catch (e) { waCheck = { rejected: false, summary: 'WhatsApp saved. Could not ask Meta just now: press Test connection.' }; }
    return res.json({ ...shapeIntegration(channel, shown), waCheck });
  }
  res.json(shapeIntegration(channel, row));
});

/* --------------------------------------------------------------------------
   EMAIL (SMTP) — the real channel.
   -------------------------------------------------------------------------- */

// Where the screen reads whether email is switched on, and what is waiting.
router.get('/integrations/email/status', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const cfg = await mailer.emailConfig();
  const [queued, retrying, sent, failed, held] = await Promise.all([
    prisma.candidateMessage.count({ where: { channel: 'Email', status: 'QUEUED' } }),
    prisma.candidateMessage.count({ where: { channel: 'Email', status: 'RETRY' } }),
    prisma.candidateMessage.count({ where: { channel: 'Email', status: 'SENT' } }),
    prisma.candidateMessage.count({ where: { channel: 'Email', status: 'FAILED' } }),
    prisma.candidateMessage.count({ where: { channel: 'Email', status: 'NOT_SENT_NO_PROVIDER' } }),
  ]);
  res.json({
    configured: cfg.configured,
    reason: cfg.reason || null,
    host: cfg.host || null,
    port: cfg.port || null,
    secure: cfg.secure,
    username: cfg.user || null,
    fromAddress: cfg.fromAddress || null,
    fromName: cfg.fromName || null,
    secretKeyConfigured: secretsConfigured(),
    secretKeyEnvVar: SECRET_ENV_VAR,
    worker: mailWorker.status(),
    queue: { queued, retrying, sent, failed, notSentNoProvider: held },
  });
});

// "Send test email" — opens a real connection, authenticates, and sends. On
// failure it reports the PROVIDER's error, not a generic one.
router.post('/integrations/email/test-message', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const to = String(req.body.to || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter the address to send the test to.' });
  const sender = await senderIdentity(req.user);
  const result = await mailer.verifyAndSendTest({
    to, senderEmail: sender.senderEmail, senderName: sender.senderName, by: req.user.name,
  });
  await recordEvent('email', {
 action: 'Test Connection', by: req.user.name,
      result: result.ok ? `Test email accepted for ${to}` : `Failed (${result.stage || 'config'}) — ${result.error}`.slice(0, 480),
    });
  await prisma.integration.update({
    where: { id: 'email' },
    data: {
      lastTest: new Date(),
      lastTestResult: result.ok ? 'Test email sent' : `Failed — ${result.error}`.slice(0, 480),
      error: result.ok ? null : String(result.error || '').slice(0, 480),
    },
  }).catch(() => {});
  await logAudit({
    userId: req.user.id, action: 'SMTP test email', entity: 'Integration', entityId: 'email',
    toValue: result.ok ? `Sent to ${to}` : 'Failed',
  });
  if (!result.ok) return res.status(502).json({ error: result.error, stage: result.stage || 'config', notConfigured: !!result.notConfigured });
  return res.json({ ok: true, to, providerRef: result.providerRef, response: result.response });
});

// Run the sending worker now. The interval loop does this on its own; this is
// the "don't wait a minute" button and what the verification script calls.
router.post('/integrations/email/worker/run', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const summary = await mailWorker.runOnce({});
  await logAudit({
    userId: req.user.id, action: 'Email worker run', entity: 'Integration', entityId: 'email',
    toValue: `${summary.sent} sent / ${summary.retried} retrying / ${summary.failed} failed`,
  });
  res.json(summary);
});

/* --------------------------------------------------------------------------
   AI ASSISTANT (Anthropic) — the real channel.
   -------------------------------------------------------------------------- */
router.post('/integrations/ai-claude/test-message', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const result = await aiAgent.testConnection();
  await recordEvent('ai-claude', {
 action: 'Test Connection', by: req.user.name,
      result: result.ok ? `Model ${result.model} answered` : `Failed — ${result.error}`.slice(0, 480),
    });
  await prisma.integration.update({
    where: { id: 'ai-claude' },
    data: {
      lastTest: new Date(),
      lastTestResult: result.ok ? `Model ${result.model} answered` : `Failed — ${result.error}`.slice(0, 480),
      error: result.ok ? null : String(result.error || '').slice(0, 480),
    },
  }).catch(() => {});
  if (!result.ok) return res.status(502).json({ error: result.error, notConfigured: !!result.notConfigured });
  return res.json(result);
});

/* --------------------------------------------------------------------------
   SMS / WHATSAPP — real channels. Status for the screen, and "send one test
   message to this number" (the administrator types their own number).
   -------------------------------------------------------------------------- */
router.get('/integrations/messaging/status', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  // eslint-disable-next-line global-require
  res.json(await require('../utils/messaging').channelStatus());
});

const TEST_MSG_SEEN = new Map();
router.post('/integrations/:id/test-message', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res, next) => {
  if (!['sms', 'whatsapp'].includes(req.params.id)) return next();
  const to = String(req.body.to || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter the mobile number to send the test to.' });
  const channel = req.params.id === 'sms' ? 'SMS' : 'WhatsApp';
  // SMS (2026-10-27): the admin types the message - with SMS Push Platform / MSG91 it must be the text of the approved Bulk / General DLT template
  const typed = String(req.body.text || '').trim().slice(0, 1000);
  const text = typed || `TeamLink test message from Administration → Integrations (${req.user.name}). If you received this, ${channel} works.`;
  // one test per number + text a minute: a double click never sends two SMS
  const dupKey = `${req.params.id}|${to.replace(/\D/g, '')}|${text}`;
  const last = TEST_MSG_SEEN.get(dupKey);
  if (last && Date.now() - last < 60000) return res.status(409).json({ error: 'This test was sent a moment ago. Wait a minute before sending the same test again.', outcome: 'Duplicate' });
  TEST_MSG_SEEN.set(dupKey, Date.now());
  if (TEST_MSG_SEEN.size > 500) TEST_MSG_SEEN.clear();
  // eslint-disable-next-line global-require
  const result = await require('../utils/messaging').send(channel, { to, kind: 'bulk', text, vars: [text], proving: channel === 'SMS', meta: { purpose: `Test ${channel}`, module: 'Integrations', senderUserId: req.user.id, senderName: req.user.name, preview: text } });
  // the words the screen shows: accepted is NOT delivered
  const err = String(result.error || '');
  const word = result.ok ? 'Accepted by Provider — Delivery Pending'
    : result.notConfigured ? 'Configuration Missing'
      : result.invalid ? 'Validation Failed'
        : result.unknown ? 'Unknown answer (not counted as sent)'
          : /did not answer|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|timed? ?out|HTTP 5\d\d/i.test(err) ? 'Connection Failed'
            : /auth|login|user ?name|password|credential|HTTP 401|HTTP 403/i.test(err) ? 'Authentication Failed'
              : 'Request Rejected';
  const summary = result.ok ? `Test ${channel}: ${word} (${result.providerRef || 'no ref'})` : `${word} — ${err}`;
  await recordEvent(req.params.id, { action: 'Test Message', by: req.user.name, result: summary.slice(0, 480) });
  await prisma.integration.update({
    where: { id: req.params.id },
    data: { lastTest: new Date(), lastTestResult: summary.slice(0, 480), error: result.ok ? null : String(result.error || '').slice(0, 480), ...(result.ok ? { state: 'Connected', connected: true } : {}) },
  }).catch(() => {});
  await logAudit({ userId: req.user.id, action: `${channel} test message`, entity: 'Integration', entityId: req.params.id, toValue: result.outcome });
  if (!result.ok) { TEST_MSG_SEEN.delete(dupKey); return res.status(result.notConfigured ? 409 : 502).json({ error: result.error, outcome: result.outcome, status: word, notConfigured: !!result.notConfigured, providerResponse: result.providerResponse || null }); }
  return res.json({ ok: true, outcome: result.outcome, status: word, providerRef: result.providerRef || null });
});

router.post('/integrations/:id/connect',requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
  if (channel.id === 'whatsapp-qr') return res.status(400).json({ error: 'Switch the QR-link prototype on at Integrations > WhatsApp & SMS (it needs the "I understand" tick).' });
  if (channel.id === 'biometric') return setBiometricStatus(req, res, channel, 'Active');
  const row = await integrationRow(channel.id);
  let values = {};
  try { values = row.values ? JSON.parse(row.values) : {}; } catch { values = {}; }
  if (!Object.values(values).filter((v) => String(v).trim()).length) {
    return res.status(400).json({ error: `Add credentials first — open Configure for ${channel.name}.` });
  }
  if (channel.id === 'social') {
    const r = await applySocial(req.user, { how: 'Connected' });
    const row2 = r.row || await integrationRow('social');
    if (!r.ok) return res.status(r.status).json({ ...shapeIntegration(channel, row2), error: `Facebook is NOT connected: ${r.words}` });
    return res.json(shapeIntegration(channel, row2));
  }
  if (channel.id === 'sms') {
    const problems = await require('../utils/smsGateway').validateSms(); // eslint-disable-line global-require
    if (problems.length) return res.status(422).json({ error: `SMS cannot be switched on yet: ${problems.join(' ')}`, problems });
  }
  const next = await prisma.integration.update({
    where: { id: channel.id },
    data: { state: 'Connected', connected: true, enabled: true, connectedAt: new Date(), error: null },
  });
  await recordEvent(channel.id, { action: 'Connected', by: req.user.name, result: LIVE_CHANNELS.includes(channel.id) ? 'Reconnected with the stored credentials' : 'OK (Demo)' });
  await logAudit({ userId: req.user.id, action: 'Integration connected (demo)', entity: 'Integration', entityId: channel.id, fromValue: row.state, toValue: 'Connected' });
  res.json(shapeIntegration(channel, next));
});

router.post('/integrations/:id/disconnect', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
  if (channel.id === 'biometric') return setBiometricStatus(req, res, channel, 'Inactive');
  const row = await integrationRow(channel.id);
  if (channel.id === 'social') {
    // the saved Page login for job posting goes too (posting switched OFF); Omni-Channel is told a few seconds later
    await require('../jobPublish/credentials').remove('facebook', req.user); // eslint-disable-line global-require
  }
  const next = await prisma.integration.update({ where: { id: channel.id }, data: { state: 'Not Connected', connected: false } });
  // A live channel really stops: the cached connection is dropped and anything
  // queued goes back to "recorded, not transmitted", which is true again.
  if (channel.id === 'email') { mailer.resetTransport(); await mailWorker.runOnce({}); }
  if (channel.id === 'ai-claude') aiAgent.resetClient();
  await recordEvent(channel.id, { action: 'Disconnected', by: req.user.name, result: 'OK' });
  await logAudit({ userId: req.user.id, action: 'Integration disconnected', entity: 'Integration', entityId: channel.id, fromValue: row.state, toValue: 'Not Connected' });
  res.json(shapeIntegration(channel, next));
});

// JOB BOARDS — the Integrations card details (Save & Post spec §14,
// utils/jobConnectors.js boardStatus): connection, account id, posting method,
// last success, last error in plain words + details. Never a credential.
router.get('/integrations/:id/board-status', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  if (!JOB_BOARD_CHANNELS.includes(req.params.id)) return res.status(404).json({ error: 'Not a job board' });
  const out = await require('../utils/jobConnectors').boardStatus(req.params.id); // eslint-disable-line global-require
  if (!out) return res.status(404).json({ error: 'Not a job board' });
  return res.json(out);
});

// "I have applied — waiting for the board's approval": a note by a person (never a fact about the
// board). Shows the board as "Waiting for approval" until its details are pasted in.
router.post('/integrations/:id/applied', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  if (!JOB_BOARD_CHANNELS.includes(req.params.id)) return res.status(404).json({ error: 'Not a job board' });
  const on = !(req.body && req.body.applied === false);
  const jc = require('../utils/jobConnectors'); // eslint-disable-line global-require
  await jc.setApplied(req.params.id, on, req.user.name, req.body && req.body.note);
  await logAudit({ userId: req.user.id, action: on ? 'Job board: applied, waiting for approval' : 'Job board: applied flag cleared', entity: 'Integration', entityId: req.params.id, toValue: String((req.body && req.body.note) || '').slice(0, 200) || null });
  return res.json(await jc.boardStatus(req.params.id));
});

router.post('/integrations/:id/test', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
  // Biometric: the device calls us, so the test is its last heartbeat.
  if (channel.id === 'biometric') {
    const device = await firstDevice();
    const st = bio.deviceState(device);
    let result;
    if (!device) result = 'No device saved — open Configure.';
    else if (st.state === 'Connected') result = `Connected — last heartbeat ${Math.round(st.ageMs / 1000)}s ago${device.lastSeenIp ? ` from ${device.lastSeenIp}` : ''}`;
    else if (st.state === 'Waiting for device') result = `No heartbeat yet — device ${device.serialNumber} has not called ${device.endpoint}`;
    else if (st.state === 'Offline') result = `Offline — last heartbeat ${new Date(device.lastSeenAt).toLocaleString()}`;
    else result = 'Inactive — the device is switched off in TeamLink';
    await integrationRow(channel.id);
    const nextRow = await prisma.integration.update({ where: { id: channel.id }, data: { lastTest: new Date(), lastTestResult: result.slice(0, 480), connected: st.connected, state: st.state } });
    await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result: result.slice(0, 480) });
    return res.json({ ...shapeIntegration(channel, nextRow), state: st.state, result, device: shapeDevice(device) });
  }
  // SOCIAL MEDIA (Facebook Page): a real, read-only check with Facebook. Nothing is posted.
  if (channel.id === 'social') {
    const r = await applySocial(req.user, { how: 'Test Connection', save: false });
    const row2 = r.row || await integrationRow('social');
    return res.json({ ...shapeIntegration(channel, row2), result: r.words, ok: r.ok });
  }
  // JOB BOARDS (Save & Post, utils/jobConnectors.js): the test says honestly
  // whether the connector has what it needs. Nothing is sent to the board.
  if (JOB_BOARD_CHANNELS.includes(channel.id)) {
    await integrationRow(channel.id);
    const report = await require('../utils/jobConnectors').boardSetupReport(channel.id); // eslint-disable-line global-require
    const result = report ? report.result : 'Unknown job board';
    const nextRow = await prisma.integration.update({
      where: { id: channel.id },
      data: { lastTest: new Date(), lastTestResult: result.slice(0, 480), error: report && report.ready ? null : result.slice(0, 480) },
    });
    await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result: result.slice(0, 480) });
    await logAudit({ userId: req.user.id, action: 'Integration test connection', entity: 'Integration', entityId: channel.id, toValue: report && report.ready ? 'Ready' : 'Not ready' });
    return res.json({ ...shapeIntegration(channel, nextRow), result });
  }
  // eMUDHRA eSIGN (utils/emudhra.js): checks the setup only — token, the
  // certificate parses, https URLs. Nothing is sent to eMudhra.
  // CALENDAR SYNC (B4, utils/meetingLinks.js): the same honest setup check.
  if (channel.id === 'esign' || channel.id === 'calendar') {
    await integrationRow(channel.id);
    const report = await require(channel.id === 'esign' ? '../utils/emudhra' : '../utils/meetingLinks').setupReport(); // eslint-disable-line global-require
    const nextRow = await prisma.integration.update({
      where: { id: channel.id },
      data: { lastTest: new Date(), lastTestResult: report.result.slice(0, 480), error: report.ready ? null : report.result.slice(0, 480) },
    });
    await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result: report.result.slice(0, 480) });
    await logAudit({ userId: req.user.id, action: 'Integration test connection', entity: 'Integration', entityId: channel.id, toValue: report.ready ? 'Ready' : 'Not ready' });
    return res.json({ ...shapeIntegration(channel, nextRow), result: report.result });
  }

  const row = await integrationRow(channel.id);
  if (row.state !== 'Connected') {
    await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result: 'Failed — not connected' });
    return res.status(409).json({ error: `${channel.name}: not connected.` });
  }

  // The two live channels really connect. Everything below them is still the
  // prototype's deterministic simulation, and the screen labels it Demo.
  if (channel.id === 'email') {
    const cfg = await mailer.emailConfig();
    let result;
    if (!cfg.configured) result = `Not configured — ${cfg.reason}`;
    else {
      try {
        // eslint-disable-next-line global-require
        const nodemailer = require('nodemailer');
        const probe = nodemailer.createTransport({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          tls: cfg.allowInsecure ? { rejectUnauthorized: false } : undefined,
          connectionTimeout: 15000,
          ...(cfg.user || cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
        });
        await probe.verify();
        probe.close();
        result = `Connected to ${cfg.host}:${cfg.port}`;
      } catch (err) {
        result = `Failed — ${mailer.providerError(err)}`;
      }
    }
    const okReal = result.startsWith('Connected');
    const nextRow = await prisma.integration.update({
      where: { id: channel.id },
      data: {
        lastTest: new Date(),
        lastTestResult: result.slice(0, 480),
        error: okReal ? null : result.slice(0, 480),
        ...(okReal ? {} : { state: 'Reconnect Required' }),
      },
    });
    await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result: result.slice(0, 480) });
    await logAudit({ userId: req.user.id, action: 'Integration test connection', entity: 'Integration', entityId: channel.id, toValue: okReal ? 'OK' : 'Failed' });
    return res.json({ ...shapeIntegration(channel, nextRow), result });
  }

  if (channel.id === 'sms-android') {
    const probe = await require('../channels/androidSms').test(); // eslint-disable-line global-require
    const nextRow = await prisma.integration.update({ where: { id: channel.id }, data: { lastTest: new Date(), lastTestResult: probe.result.slice(0, 480), error: probe.ok ? null : probe.result.slice(0, 480) } });
    await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result: probe.result.slice(0, 480) });
    await logAudit({ userId: req.user.id, action: 'Integration test connection', entity: 'Integration', entityId: channel.id, toValue: probe.ok ? 'OK' : 'Failed' });
    return res.json({ ...shapeIntegration(channel, nextRow), result: probe.result });
  }
  // SMS / WhatsApp are real now (utils/smsGateway.js, utils/whatsappCloud.js):
  // the test is an authenticated read at the provider that sends nothing.
  if (channel.id === 'sms' || channel.id === 'whatsapp') {
    // eslint-disable-next-line global-require
    const probe = await (channel.id === 'sms' ? require('../utils/smsGateway') : require('../utils/whatsappCloud')).testConnection();
    const nextRow = await prisma.integration.update({
      where: { id: channel.id },
      data: {
        lastTest: new Date(), lastTestResult: probe.result.slice(0, 480),
        error: probe.ok || probe.needsConfirmation ? null : probe.result.slice(0, 480),
        // SMS Push Platform has no connection-test call: "not proven yet" (send a Test SMS) is not a broken connection
        ...(probe.ok ? { state: 'Connected' } : probe.needsConfirmation ? {} : { state: 'Reconnect Required' }),
      },
    });
    await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result: probe.result.slice(0, 480) });
    await logAudit({ userId: req.user.id, action: 'Integration test connection', entity: 'Integration', entityId: channel.id, toValue: probe.ok ? 'OK' : 'Failed' });
    return res.json({ ...shapeIntegration(channel, nextRow), result: probe.result });
  }

  // The TeamLink Job Portal is a real app of our own: test that it answers.
  if (channel.id === 'jobportal') {
    const probe = await require('../utils/jobPortalBridge').ping();
    const nextRow = await prisma.integration.update({
      where: { id: channel.id },
      data: {
        lastTest: new Date(), lastTestResult: probe.result.slice(0, 480),
        error: probe.ok ? null : probe.result.slice(0, 480),
        ...(probe.ok ? {} : { state: 'Reconnect Required' }),
      },
    });
    await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result: probe.result.slice(0, 480) });
    await logAudit({ userId: req.user.id, action: 'Integration test connection', entity: 'Integration', entityId: channel.id, toValue: probe.ok ? 'OK' : 'Failed' });
    return res.json({ ...shapeIntegration(channel, nextRow), result: probe.result });
  }

  if (channel.id === 'ai-claude') {
    const probe = await aiAgent.testConnection();
    const result = probe.ok ? `Model ${probe.model} answered` : `Failed — ${probe.error}`;
    const nextRow = await prisma.integration.update({
      where: { id: channel.id },
      data: {
        lastTest: new Date(),
        lastTestResult: result.slice(0, 480),
        error: probe.ok ? null : result.slice(0, 480),
        // A passing test (e.g. after credits were bought) clears an earlier
        // "Reconnect Required" — it used to stay stuck on it.
        ...(probe.ok ? { state: 'Connected' } : { state: 'Reconnect Required' }),
      },
    });
    await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result: result.slice(0, 480) });
    await logAudit({ userId: req.user.id, action: 'Integration test connection', entity: 'Integration', entityId: channel.id, toValue: probe.ok ? 'OK' : 'Failed' });
    return res.json({ ...shapeIntegration(channel, nextRow), result });
  }

  // Deterministic, exactly like the prototype: the TeamLink portal always
  // answers, every other channel answers by a stable hash of its id.
  const ok = channel.id === 'jobportal' || detBool(`intg:${channel.id}`, 80);
  const result = ok ? 'Reachable (Demo)' : 'No response (Demo)';
  const next = await prisma.integration.update({
    where: { id: channel.id },
    data: {
      lastTest: new Date(), lastTestResult: result,
      ...(ok ? {} : { state: 'Reconnect Required', error: 'Endpoint did not respond during the simulated test.' }),
    },
  });
  await recordEvent(channel.id, { action: 'Test Connection', by: req.user.name, result });
  await logAudit({ userId: req.user.id, action: 'Integration test connection', entity: 'Integration', entityId: channel.id, toValue: result });
  res.json({ ...shapeIntegration(channel, next), result });
});

router.post('/integrations/:id/sync', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
  if (channel.id === 'biometric') return res.status(400).json({ error: 'The device pushes its punches to TeamLink by itself — there is nothing to pull.' });
  const row = await integrationRow(channel.id);
  if (row.state !== 'Connected') return res.status(409).json({ error: `${channel.name} is not connected — connect it first.` });

  let synced = 0;
  let failed = 0;
  let entities = ['Requirement Status'];
  if (channel.id === 'jobportal') {
    const stats = await jobPortalStats();
    synced = stats.candidates + stats.applications;
    failed = stats.failed;
    entities = SYNC_ENTITIES.jobportal;
  } else if (JOB_BOARD_CHANNELS.includes(channel.id) && prisma.requirementPosting) {
    // Save & Post: the real per-job results of this board's connector.
    const src = { 'google-jobs': 'google' }[channel.id] || channel.id;
    const rows = await prisma.requirementPosting.groupBy({ by: ['status'], where: { source: src }, _count: { _all: true } });
    const n = (st) => rows.filter((x) => st.includes(x.status)).reduce((a, x) => a + x._count._all, 0);
    synced = n(['Posted']);
    failed = n(['Failed']);
    entities = ['Requirements'];
  } else {
    // External boards are simulated, but the counts derive from real postings.
    const posted = await prisma.requirement.findMany({ where: { postingSources: { contains: channel.name } }, select: { status: true } });
    synced = posted.filter((r) => requirementIsLive(r.status)).length;
    failed = posted.filter((r) => r.status === 'DRAFT').length;
  }
  const next = await prisma.integration.update({
    where: { id: channel.id },
    data: {
      lastSync: new Date(), recordsSynced: synced, recordsFailed: failed,
      error: failed ? `${failed} record(s) could not be synced${JOB_BOARD_CHANNELS.includes(channel.id) ? ' — see the Posted on card of each requirement' : ' (simulated)'}.` : null,
    },
  });
  await recordEvent(channel.id, {
 action: 'Sync Now', by: req.user.name,
      result: failed ? 'Completed with errors' : 'Completed', synced, failed, entities: entities.join(', '),
    });
  await logAudit({ userId: req.user.id, action: 'Integration sync', entity: 'Integration', entityId: channel.id, toValue: `${synced} synced / ${failed} failed` });
  res.json({ ...shapeIntegration(channel, next), synced, failed });
});

module.exports = router;
