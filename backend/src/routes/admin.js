const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requirePerm, can: canPerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { strengthError, passwordEventData, passwordStatusOf } = require('../utils/passwordPolicy');
const {
  ROLE_FEATURE_ACTIONS, ROLE_ACCESS_MODULES, CATALOG_ROLES, ROLE_SCOPE_DESC,
  PRODUCTS, PRODUCT_OF_MODULE, productKeyOf, NO_ROLE,
  moduleById, sanitizeFeatures, featureInfoOf,
} = require('../utils/roleAccess');
const {
  mergeAccess, invalidateRoleAccess, accessFor, viewOnlyLocksFor,
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
  COMPANY_POLICIES, COMPANY_DEFAULTS, integrationById, LIVE_CHANNELS, JOB_BOARD_CHANNELS,
} = require('../utils/adminCatalog');
const { DEPTS, LOCS, REQUIREMENT_LIVE_STATUSES, requirementIsLive } = require('../utils/atsVocab');
const { publicValuesFor, writeValues, recordEvent } = require('../utils/integrationStore');
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

// The wide row the Users table renders: login + linked employee + reach.
async function shapeUser(user) {
  const [assignedAsRecruiter, assignedAsBde] = await Promise.all([
    prisma.requirement.findMany({ where: { recruiterId: user.id }, include: { client: true } }),
    prisma.requirement.findMany({ where: { bdeId: user.id }, include: { client: true } }),
  ]);
  const requirements = [...assignedAsRecruiter, ...assignedAsBde];
  const emp = user.employee;
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

router.get('/users', requirePerm(null, 'administration', 'Users', 'view'), async (req, res) => {
  const users = await prisma.user.findMany({
    include: { employee: true, client: true },
    orderBy: { name: 'asc' },
  });
  res.json(await Promise.all(users.map(shapeUser)));
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

router.post('/users', requirePerm(null, 'administration', 'Users', 'create'), async (req, res) => {
  const { name, email, password, role, atsDepartment, clientId, employeeId, branch, team, username, status } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password and role are required' });
  if (!ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (status && !USER_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  if (role === 'CLIENT' && !clientId) return res.status(400).json({ error: 'A Client login must be tied to one client' });
  { const bad = await productRoleError(req.body); if (bad) return res.status(400).json({ error: bad }); }

  // ONE PERSON, ONE LOGIN — checked BEFORE anything is written. Case-
  // insensitive, because "Kiran@x" and "kiran@x" are the same mailbox and
  // SQLite's = is case-sensitive.
  const norm = String(email).trim().toLowerCase();
  const [sameLogin] = await prisma.$queryRaw`SELECT id FROM User WHERE lower(trim(email)) = ${norm} LIMIT 1`;
  if (sameLogin) return res.status(409).json({ error: 'That email already has a login' });
  let linkEmployee = null;
  if (employeeId) {
    linkEmployee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!linkEmployee) return res.status(404).json({ error: 'Employee not found' });
    if (linkEmployee.userId) return res.status(409).json({ error: 'That employee already has a login' });
  }
  // An EMPLOYEE record with this email is the same person. A second login for
  // them (e.g. a separate "recruiter" account) is exactly what the one-user
  // model forbids: give the ATS role to their existing login on this screen,
  // or pick the employee here so this login is linked to them.
  if (!['CLIENT', 'CANDIDATE'].includes(role)) {
    const [emp] = await prisma.$queryRaw`SELECT id, userId, name, employeeCode FROM Employee WHERE lower(trim(email)) = ${norm} LIMIT 1`;
    if (emp && emp.id !== employeeId) {
      return res.status(409).json({
        error: emp.userId
          ? `${emp.name} (${emp.employeeCode}) already has a login. Add the ATS / Accounts role to that login instead of creating a second one.`
          : `That email belongs to employee ${emp.name} (${emp.employeeCode}). Select that employee so the login is linked to them.`,
      });
    }
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      // The administrator typed this first password, so its owner must
      // change it (hrms-24 §12).
      ...passwordEventData('initial'),
      name, email, passwordHash, role, atsDepartment, clientId,
      branch, team, username: username || email, status: status || 'Active',
      ...accessPatch(req.body),
    },
  });

  // Access is granted TO an existing employee — never a second identity.
  // (Validated above, before the login was created.)
  if (linkEmployee) {
    await prisma.employee.update({ where: { id: linkEmployee.id }, data: { userId: user.id } });
  }

  await logAudit({ userId: req.user.id, action: 'User created', entity: 'User', entityId: user.id, toValue: `${role} · ${user.status}` });
  res.status(201).json(await shapeUser(await prisma.user.findUnique({ where: { id: user.id }, include: { employee: true, client: true } })));
});

router.put('/users/:id', requirePerm(null, 'administration', 'Users', 'edit'), async (req, res) => {
  const { name, role, atsDepartment, branch, team, status, username } = req.body;
  if (role && !ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (status && !USER_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'User not found' });
  { const bad = await productRoleError(req.body, existing); if (bad) return res.status(400).json({ error: bad }); }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { name, role, atsDepartment, branch, team, status, username, ...accessPatch(req.body) },
    include: { employee: true, client: true },
  });
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
  const next = (existing.status || 'Active') === 'Active' ? 'Inactive' : 'Active';
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: next }, include: { employee: true, client: true } });
  await logAudit({ userId: req.user.id, action: `Login ${next === 'Active' ? 'enabled' : 'disabled'} for ${user.name}`, entity: 'User', entityId: user.id, fromValue: existing.status, toValue: next });
  res.json(await shapeUser(user));
});

router.post('/users/:id/reset-password', requirePerm(null, 'administration', 'Users', 'edit'), async (req, res) => {
  const { password } = req.body;
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'User not found' });
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
  res.json({ ok: true, passwordStatus: passwordStatusOf(await prisma.user.findUnique({ where: { id: existing.id } })) });
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
      users: reg.isSystem ? countFor(role) : (customCounts[role] || 0),
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
      // HRMS / Accounts modules: what each feature drives and whether an
      // endpoint checks it by name (utils/roleAccess.js SPLIT_MODULES).
      featureInfo: featureInfoOf(m.id),
      // Manager / Assistant Manager: actions the server ignores (§3/§4).
      locked: viewOnlyLocksFor(role, m.id),
      ...mergeAccess(role, m.id, ...rowsFor(rows, role, m.id)),
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

router.get('/notifications', async (req, res) => {
  if (req.query.page !== undefined) {
    const own = { userId: req.user.id };
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
    return res.json({ rows: rows.map(shapeNotification), total, page, pageSize, channels, unread });
  }
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user.id },
    // Name only — never the password hash (hrms-24 §12).
    include: { user: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  // Recipient / Channel / Status are the prototype's Notifications columns.
  // Rows written before those columns existed fall back to the owning user,
  // the in-app channel, and the delivered/pending state we actually know.
  res.json(notifications.map((n) => ({
    ...n,
    recipient: n.recipient || n.user?.name || 'Everyone',
    channel: n.channel || 'In-App',
    status: n.status || (n.read ? 'Read' : 'Delivered'),
  })));
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
    why = r.ok ? `${r.jobs} job(s) live, ${r.failed} failed, ${r.errors.length} problem(s)` : r.error;
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

router.post('/integrations/:id/test-message', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res, next) => {
  if (!['sms', 'whatsapp'].includes(req.params.id)) return next();
  const to = String(req.body.to || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter the mobile number to send the test to.' });
  const channel = req.params.id === 'sms' ? 'SMS' : 'WhatsApp';
  const text = `TeamLink test message from Administration → Integrations (${req.user.name}). If you received this, ${channel} works.`;
  // eslint-disable-next-line global-require
  const result = await require('../utils/messaging').send(channel, { to, kind: 'bulk', text, vars: [text] });
  const summary = result.ok ? `Test ${channel} accepted by the provider (${result.providerRef || 'no ref'})` : `${result.outcome} — ${result.error}`;
  await recordEvent(req.params.id, { action: 'Test Message', by: req.user.name, result: summary.slice(0, 480) });
  await prisma.integration.update({
    where: { id: req.params.id },
    data: { lastTest: new Date(), lastTestResult: summary.slice(0, 480), error: result.ok ? null : String(result.error || '').slice(0, 480) },
  }).catch(() => {});
  await logAudit({ userId: req.user.id, action: `${channel} test message`, entity: 'Integration', entityId: req.params.id, toValue: result.outcome });
  if (!result.ok) return res.status(result.notConfigured ? 409 : 502).json({ error: result.error, outcome: result.outcome, notConfigured: !!result.notConfigured });
  return res.json({ ok: true, outcome: result.outcome, providerRef: result.providerRef || null });
});

router.post('/integrations/:id/connect',requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
  if (channel.id === 'biometric') return setBiometricStatus(req, res, channel, 'Active');
  const row = await integrationRow(channel.id);
  let values = {};
  try { values = row.values ? JSON.parse(row.values) : {}; } catch { values = {}; }
  if (!Object.values(values).filter((v) => String(v).trim()).length) {
    return res.status(400).json({ error: `Add credentials first — open Configure for ${channel.name}.` });
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

  // SMS / WhatsApp are real now (utils/smsGateway.js, utils/whatsappCloud.js):
  // the test is an authenticated read at the provider that sends nothing.
  if (channel.id === 'sms' || channel.id === 'whatsapp') {
    // eslint-disable-next-line global-require
    const probe = await (channel.id === 'sms' ? require('../utils/smsGateway') : require('../utils/whatsappCloud')).testConnection();
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
  let entities = ['Job Status'];
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
      error: failed ? `${failed} record(s) could not be synced${JOB_BOARD_CHANNELS.includes(channel.id) ? ' — see the Posted on card of each job' : ' (simulated)'}.` : null,
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
