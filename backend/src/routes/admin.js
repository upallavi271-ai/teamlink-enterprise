const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const {
  ROLE_FEATURE_ACTIONS, ROLE_ACCESS_MODULES, CATALOG_ROLES, ROLE_SCOPE_DESC,
  moduleById, sanitizeFeatures,
} = require('../utils/roleAccess');
const { mergeAccess, invalidateRoleAccess } = require('../utils/permissions');
const { invalidateDesignationMap } = require('../utils/identity');
const {
  ALL_ROLES, ATS_ROLES, productAccessOf, scopeLabelOf,
  designationRows, defaultProductAccessByRole,
} = require('../utils/employeeAdmin');
const {
  INTEGRATION_CATALOG, INTEGRATION_GROUPS, SYNC_ENTITIES, ORG_STRUCTURE_DEFAULT,
  COMPANY_POLICIES, COMPANY_DEFAULTS, integrationById, LIVE_CHANNELS,
} = require('../utils/adminCatalog');
const { DEPTS, LOCS, REQUIREMENT_LIVE_STATUSES, requirementIsLive } = require('../utils/atsVocab');
const { publicValuesFor, writeValues, recordEvent } = require('../utils/integrationStore');
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
function accessPatch(body) {
  const data = {};
  const p = body.products || {};
  if (body.hrmsAccess !== undefined || p.hrms !== undefined) data.hrmsAccess = !!(body.hrmsAccess ?? p.hrms);
  if (body.atsAccess !== undefined || p.ats !== undefined) data.atsAccess = !!(body.atsAccess ?? p.ats);
  if (body.accountsAccess !== undefined || p.accounts !== undefined) data.accountsAccess = !!(body.accountsAccess ?? p.accounts);
  if (body.atsRole !== undefined) data.atsRole = body.atsRole || null;
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

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username || user.email,
    role: user.role,
    productAccess: productAccessOf(user),
    products: { hrms: !!user.hrmsAccess, ats: !!user.atsAccess, accounts: !!user.accountsAccess },
    atsRole: user.atsRole || null,
    atsScopeDepartments: user.atsScopeDepartments || '',
    atsScopeTeams: user.atsScopeTeams || '',
    atsScopeClients: user.atsScopeClients || '',
    status: user.status || 'Active',
    employeeId: emp ? emp.employeeCode : null,
    employeeRecordId: emp ? emp.id : null,
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

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'That email already has a login' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      name, email, passwordHash, role, atsDepartment, clientId,
      branch, team, username: username || email, status: status || 'Active',
      ...accessPatch(req.body),
    },
  });

  // Access is granted TO an existing employee — never a second identity.
  if (employeeId) {
    const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (emp.userId) return res.status(409).json({ error: 'That employee already has a login' });
    await prisma.employee.update({ where: { id: employeeId }, data: { userId: user.id } });
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
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'A password of at least 6 characters is required' });
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'User not found' });
  await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash: await bcrypt.hash(String(password), 10) } });
  // The new password is never echoed back or logged.
  await logAudit({ userId: req.user.id, action: `Password reset for ${existing.name}`, entity: 'User', entityId: existing.id, toValue: 'Reset' });
  res.json({ ok: true });
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
    rows: await designationRows(),
    atsRoles: ATS_ROLES,
    designations: [...new Set((await prisma.employee.findMany({ select: { designation: true } }))
      .map((e) => e.designation).filter(Boolean))].sort(),
  });
});

router.put('/designation-roles/:designation', requirePerm(null, 'administration', 'Users', 'configure'), async (req, res) => {
  const designation = decodeURIComponent(req.params.designation);
  const { atsRole, hrms, ats, accounts, landing } = req.body;
  if (atsRole && !ATS_ROLES.includes(atsRole)) return res.status(400).json({ error: 'Unknown ATS role' });
  const data = {
    atsRole: atsRole || null,
    hrms: hrms !== undefined ? !!hrms : true,
    ats: ats !== undefined ? !!ats : !!atsRole,
    accounts: accounts !== undefined ? !!accounts : false,
    landing: landing || null,
  };
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

  res.json(CATALOG_ROLES.map((role) => {
    const modules = ROLE_ACCESS_MODULES.map((m) => {
      const merged = mergeAccess(role, m.id, rows.find((r) => r.role === role && r.moduleId === m.id));
      return { id: m.id, label: m.label, enabled: merged.moduleEnabled };
    });
    const enabled = modules.filter((m) => m.enabled);
    return {
      role,
      users: countFor(role),
      scope: ROLE_SCOPE_DESC[role] || '—',
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
  res.json({ actions: ROLE_FEATURE_ACTIONS, modules: ROLE_ACCESS_MODULES });
});

// One role's full matrix: every module, every feature, every action.
router.get('/role-catalog/:role/access', requirePerm(null, 'administration', 'Role Catalog', 'view'), async (req, res) => {
  const { role } = req.params;
  if (!CATALOG_ROLES.includes(role)) return res.status(404).json({ error: 'Unknown role' });
  const rows = await prisma.roleAccess.findMany({ where: { role } });
  res.json({
    role,
    scope: ROLE_SCOPE_DESC[role] || '—',
    actions: ROLE_FEATURE_ACTIONS,
    modules: ROLE_ACCESS_MODULES.map((m) => ({
      id: m.id,
      label: m.label,
      featureNames: m.features,
      ...mergeAccess(role, m.id, rows.find((r) => r.moduleId === m.id)),
    })),
  });
});

async function upsertRoleAccess(role, moduleId, patch) {
  const rows = await prisma.roleAccess.findUnique({ where: { role_moduleId: { role, moduleId } } });
  const current = mergeAccess(role, moduleId, rows);
  const next = { ...current, ...patch };
  await prisma.roleAccess.upsert({
    where: { role_moduleId: { role, moduleId } },
    create: { role, moduleId, moduleEnabled: next.moduleEnabled, features: JSON.stringify(next.features) },
    update: { moduleEnabled: next.moduleEnabled, features: JSON.stringify(next.features) },
  });
  // The permission engine caches the matrix; an admin's edit must bite now.
  invalidateRoleAccess(role);
  return next;
}

// Turn a whole module on or off for a role.
router.put('/role-catalog/:role/modules/:moduleId', requirePerm(null, 'administration', 'Role Catalog', 'configure'), async (req, res) => {
  const { role, moduleId } = req.params;
  if (!CATALOG_ROLES.includes(role)) return res.status(404).json({ error: 'Unknown role' });
  const mod = moduleById(moduleId);
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });

  const before = mergeAccess(role, moduleId, await prisma.roleAccess.findUnique({ where: { role_moduleId: { role, moduleId } } }));
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
  if (!CATALOG_ROLES.includes(role)) return res.status(404).json({ error: 'Unknown role' });
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
router.get('/departments', async (req, res) => {
  const departments = await prisma.department.findMany({ include: { teams: { orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } });
  res.json(departments);
});

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
router.get('/notifications', async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { OR: [{ userId: req.user.id }, { userId: null }] },
    include: { user: true },
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
  if (!existing || (existing.userId && existing.userId !== req.user.id)) {
    return res.status(404).json({ error: 'Notification not found' });
  }
  const notification = await prisma.notification.update({ where: { id: req.params.id }, data: { read: true } });
  res.json(notification);
});

router.post('/notifications/read-all', async (req, res) => {
  await prisma.notification.updateMany({
    where: { read: false, OR: [{ userId: req.user.id }, { userId: null }] },
    data: { read: true },
  });
  res.json({ ok: true });
});

// ---- Audit logs ----
router.get('/audit', requirePerm(null, 'administration', 'Audit Logs', 'view'), async (req, res) => {
  const logs = await prisma.auditLog.findMany({ include: { user: true }, orderBy: { createdAt: 'desc' }, take: 200 });
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
  const [roles, departments] = await Promise.all([orgRoles(), prisma.department.findMany({ include: { teams: { orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } })]);
  const branches = [...new Set((await prisma.employee.findMany({ select: { branch: true, location: true } }))
    .map((e) => e.branch || e.location).filter(Boolean))].sort();
  res.json({
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
  const role = await prisma.orgRole.create({
    data: { name: String(name).trim(), description: (description && String(description).trim()) || '—', system: false, paused: false, position: rows.length },
  });
  await logAudit({ userId: req.user.id, action: 'Approval-chain role added', entity: 'OrgRole', entityId: role.id, toValue: role.name });
  res.status(201).json(role);
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
  res.json(role);
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

async function jobPortalStats() {
  const [candidates, applications, requirements, needsMapping, failed] = await Promise.all([
    prisma.candidate.count({ where: { source: 'Job Portal' } }),
    prisma.application.count({ where: { candidate: { source: 'Job Portal' } } }),
    prisma.requirement.count({ where: { status: { in: REQUIREMENT_LIVE_STATUSES }, postingSources: { contains: 'Job Portal' } } }),
    // A portal candidate who never landed on a requirement still needs mapping.
    prisma.candidate.count({ where: { source: 'Job Portal', applications: { none: {} } } }),
    prisma.syncLog.count({ where: { status: 'Failed' } }),
  ]);
  return { candidates, applications, requirements, needsMapping, failed };
}

router.get('/integrations', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const rows = await prisma.integration.findMany();
  const channels = INTEGRATION_CATALOG.map((c) => shapeIntegration(c, rows.find((r) => r.id === c.id)));
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
    lastSyncResult: row.recordsFailed ? 'Completed with errors' : 'Synced',
    syncLog: log.map((l) => ({
      id: l.id,
      date: new Date(l.createdAt).toLocaleString(),
      entity: l.entity,
      status: l.status,
      reason: l.reason,
    })),
  });
});

// Sync — for the Job Portal this really re-counts what has come across from
// the public careers site and writes a log row. No external API is called.
router.post('/integrations/job-portal/sync', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
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
  res.json({ ok: true, synced, failed: stats.failed, previousState: row.state });
});

router.post('/integrations/job-portal/log/:id/retry', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const entry = await prisma.syncLog.findUnique({ where: { id: req.params.id } });
  if (!entry) return res.status(404).json({ error: 'Log entry not found' });
  const updated = await prisma.syncLog.update({ where: { id: req.params.id }, data: { status: 'Success', reason: 'Retried successfully' } });
  await logAudit({ userId: req.user.id, action: 'Sync record retried', entity: 'SyncLog', entityId: entry.id, fromValue: entry.status, toValue: 'Success' });
  res.json(updated);
});

router.get('/integrations/:id/history', requirePerm(null, 'administration', 'Integrations', 'view'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
  const events = await prisma.integrationEvent.findMany({ where: { integrationId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 25 });
  res.json({
    channel: channel.name,
    history: events.map((e) => ({
      at: new Date(e.createdAt).toLocaleString(), action: e.action, by: e.by,
      result: e.result, synced: e.synced, failed: e.failed, entities: e.entities,
    })),
  });
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

router.post('/integrations/:id/connect', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
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
  await recordEvent(channel.id, { action: 'Connected', by: req.user.name, result: 'OK (Demo)' });
  await logAudit({ userId: req.user.id, action: 'Integration connected (demo)', entity: 'Integration', entityId: channel.id, fromValue: row.state, toValue: 'Connected' });
  res.json(shapeIntegration(channel, next));
});

router.post('/integrations/:id/disconnect', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
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

router.post('/integrations/:id/test', requirePerm(null, 'administration', 'Integrations', 'configure'), async (req, res) => {
  const channel = integrationById(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Unknown channel' });
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

  if (channel.id === 'ai-claude') {
    const probe = await aiAgent.testConnection();
    const result = probe.ok ? `Model ${probe.model} answered` : `Failed — ${probe.error}`;
    const nextRow = await prisma.integration.update({
      where: { id: channel.id },
      data: {
        lastTest: new Date(),
        lastTestResult: result.slice(0, 480),
        error: probe.ok ? null : result.slice(0, 480),
        ...(probe.ok ? {} : { state: 'Reconnect Required' }),
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
      error: failed ? `${failed} record(s) could not be synced (simulated).` : null,
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
