// ---------------------------------------------------------------------------
// THE ROLE REGISTRY — roles as data (Role & Permission Management).
//
// "When Super Admin creates a role it must automatically become available
// throughout the application. Do NOT hardcode the role dropdown."
//
// The Role table holds the 13 system roles (seeded here, isSystem) and the
// custom roles an administrator adds (code CUSTOM_…). Every role dropdown —
// Add Employee, Users, Role Catalog, filters — reads listRoles().
//
// PERMISSIONS: a custom role has NO built-in defaults. permissions.js
// defaultAccessForRole() already grants nothing to a code it does not know
// (no DEFAULT_RULES entry, no DEFAULT_MODULES entry), so DENY BY DEFAULT is
// the engine's own behaviour; what the role may do is exactly its RoleAccess
// rows, written from the Role Catalog matrix below (engineRowsFor) and
// editable in detail on Role Catalog -> Edit Access like any system role.
//
// DATA SCOPE: utils/scope.js decides visibility by role TYPE (RECRUITER sees
// own assignments, TL own team, …). A custom code is not a type it knows, so
// a custom role borrows the scope of a system role — the ALIAS — per product:
//
//   scopeLevel   HRMS        ATS          Accounts
//   OWN          EMPLOYEE    RECRUITER    EMPLOYEE    (own records only)
//   TEAM         TL          TL           EMPLOYEE
//   DEPARTMENT   STL         STL          ACCOUNTANT
//   ALL          HR          ADMIN        ADMIN       (company-wide)
//
// behavesLike.ats (optional) overrides the ATS alias — it is also what ATS
// stage ownership (permissions.js STAGE_OWNERS) resolves against, so a
// "Senior Recruiter" that behaves like RECRUITER owns the recruiter's moves.
// The alias NEVER grants a permission: identity.js puts it on
// req.user.scopeRoles, and only scope.js / stage ownership read that.
// NOTE: ALL in ATS / Accounts is Admin-like scope, and scope is per LOGIN,
// not per product — give ALL only to administrative roles.
//
// Role codes that still appear literally in routes (e.g. `atsRole === 'TL'`
// in a few ATS reports) do not recognise a custom code; such a check treats
// the holder as "not that role", i.e. the narrower answer.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const {
  CATALOG_ROLES, ROLE_SCOPE_DESC, ROLE_ACCESS_MODULES, productKeyOf, sanitizeFeatures, LEGACY_INDEX, LEGACY_MODULES,
} = require('./roleAccess');

const SYSTEM_ROLE_NAMES = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  ASSISTANT_MANAGER: 'Assistant Manager',
  STL: 'STL',
  TL: 'TL',
  HR: 'HR',
  RECRUITER: 'Recruiter',
  BDE: 'BDE',
  CLIENT: 'Client',
  ACCOUNTANT: 'Accountant',
  EMPLOYEE: 'Employee',
  CANDIDATE: 'Candidate',
};
const SYSTEM_SCOPE_LEVEL = {
  SUPER_ADMIN: 'ALL', ADMIN: 'ALL', MANAGER: 'ALL', ASSISTANT_MANAGER: 'ALL', HR: 'ALL',
  STL: 'DEPARTMENT', TL: 'TEAM',
  RECRUITER: 'OWN', BDE: 'OWN', CLIENT: 'OWN', ACCOUNTANT: 'OWN', EMPLOYEE: 'OWN', CANDIDATE: 'OWN',
};
const EXTERNAL_ROLES = ['CLIENT', 'CANDIDATE'];
const SCOPE_LEVELS = ['OWN', 'TEAM', 'DEPARTMENT', 'ALL'];
const SCOPE_LEVEL_LABEL = {
  OWN: 'Own records', TEAM: 'Team', DEPARTMENT: 'Department', ALL: 'All (company-wide)',
};
const SCOPE_ALIAS = {
  OWN: { hrms: 'EMPLOYEE', ats: 'RECRUITER', accounts: 'EMPLOYEE' },
  TEAM: { hrms: 'TL', ats: 'TL', accounts: 'EMPLOYEE' },
  DEPARTMENT: { hrms: 'STL', ats: 'STL', accounts: 'ACCOUNTANT' },
  ALL: { hrms: 'HR', ats: 'ADMIN', accounts: 'ADMIN' },
};
// What "behaves like" may name in ATS: the ATS working roles. Never Super
// Admin / Admin — use scope ALL for company-wide reach.
const BEHAVES_LIKE_ATS = ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR', 'EMPLOYEE'];

// ---------------------------------------------------------------------------
// THE ROLE CATALOG MATRIX — the modules x actions the Add / Edit Role form
// shows, and how each maps onto the engine's module / feature / action.
//
// Several rows share one engine feature (Attendance, Regularization and
// Timesheet are all `hrms / Attendance & Time`; LMS, Performance and Rewards
// are all `Performance & Development`; Assets and Documents are `Employee
// Services`), so a tick on any of them grants that feature — the engine does
// not split them finer. Reject is the approval DECISION (the engine's
// `approve` covers approve and reject); Import is `create` (the engine has no
// separate import action). Nothing here grants `assign` or `configure`;
// Role Catalog -> Edit Access sets those per feature.
// ---------------------------------------------------------------------------
const MATRIX_ACTIONS = ['view', 'add', 'edit', 'delete', 'approve', 'reject', 'export', 'import'];
const ACTION_TO_ENGINE = {
  view: 'view', add: 'create', edit: 'edit', delete: 'delete',
  approve: 'approve', reject: 'approve', export: 'export', import: 'create',
};
const featuresOf = (moduleId, except = []) => (ROLE_ACCESS_MODULES.find((m) => m.id === moduleId)?.features || [])
  .filter((f) => !except.includes(f));
// HRMS / Accounts are split into modules (roleAccess.js SPLIT_MODULES). A row
// that used to grant one old area — say `hrms / Attendance & Time` — now grants
// every split feature that INHERITS that area, which is exactly the reach the
// old area had (Shift Roster and Timesheet included, as Employee Services
// always carried them). Coarse on purpose: re-saving an existing custom role
// from this form must not change what it can do. Finer control is Role
// Catalog -> Edit Access -> Configure.
const legacyTargets = (legacyModule, ...areas) => {
  const byModule = new Map();
  areas.forEach((area) => (LEGACY_INDEX[legacyModule][area] || []).forEach(([m, f]) => {
    if (!byModule.has(m)) byModule.set(m, []);
    byModule.get(m).push(f);
  }));
  return [...byModule.entries()];
};
const MATRIX_ROWS = [
  { id: 'employee_management', label: 'Employee Management', product: 'hrms', targets: legacyTargets('hrms', 'Employee Management') },
  { id: 'attendance', label: 'Attendance', product: 'hrms', targets: legacyTargets('hrms', 'Attendance & Time') },
  { id: 'leave', label: 'Leave', product: 'hrms', targets: legacyTargets('hrms', 'Leave & Holidays') },
  { id: 'regularization', label: 'Regularization', product: 'hrms', targets: legacyTargets('hrms', 'Attendance & Time') },
  { id: 'payroll', label: 'Payroll', product: 'hrms', targets: legacyTargets('hrms', 'Payroll & Compensation') },
  { id: 'lms', label: 'LMS', product: 'hrms', targets: legacyTargets('hrms', 'Performance & Development') },
  { id: 'performance', label: 'Performance', product: 'hrms', targets: legacyTargets('hrms', 'Performance & Development') },
  { id: 'timesheet', label: 'Timesheet', product: 'hrms', targets: legacyTargets('hrms', 'Attendance & Time') },
  { id: 'assets', label: 'Assets', product: 'hrms', targets: legacyTargets('hrms', 'Employee Services') },
  { id: 'rewards', label: 'Rewards', product: 'hrms', targets: legacyTargets('hrms', 'Performance & Development') },
  { id: 'documents', label: 'Documents', product: 'hrms', targets: legacyTargets('hrms', 'Employee Services') },
  // Reports follow the products the role holds (see engineRowsFor).
  { id: 'reports', label: 'Reports', product: null, targets: [['reports', ['HRMS Reports', 'ATS Reports', 'Job Portal Reports', 'Accounts Reports']]] },
  // Recruitment = the ATS working modules. NOT Clients: full client details
  // are the client desk's (SA / Admin / Manager / AM / BDE), so they are a row
  // of their own; the client-facing features never belong to a staff role.
  {
    id: 'recruitment',
    label: 'Recruitment',
    product: 'ats',
    targets: [
      ['requirements', featuresOf('requirements', ['Client Job Portal'])],
      ['candidates', featuresOf('candidates')],
      ['recruiterbde', featuresOf('recruiterbde')],
      ['interviews', featuresOf('interviews', ['Client Feedback'])],
    ],
  },
  { id: 'clients', label: 'Clients (full client details)', product: 'ats', targets: [['clients', featuresOf('clients')]] },
  { id: 'accounts', label: 'Accounts', product: 'accounts', targets: legacyTargets('accounts', ...LEGACY_MODULES.accounts.features) },
];
const REPORT_FEATURE_PRODUCT = {
  'HRMS Reports': 'hrms', 'ATS Reports': 'ats', 'Job Portal Reports': 'ats', 'Accounts Reports': 'accounts',
};
// Every module the matrix writes, so an edit can also CLEAR a module. The
// HRMS Dashboard module is written by the hrmsView rule in engineRowsFor.
const HRMS_DASHBOARD_TARGETS = legacyTargets('hrms', 'HRMS Dashboard');
const MATRIX_MODULES = [...new Set([
  ...MATRIX_ROWS.flatMap((r) => r.targets.map(([m]) => m)),
  ...HRMS_DASHBOARD_TARGETS.map(([m]) => m),
])];

// Keep only known rows and actions.
function cleanMatrix(input) {
  const out = {};
  MATRIX_ROWS.forEach((r) => {
    const given = input && input[r.id];
    const list = Array.isArray(given) ? given : (given && typeof given === 'object'
      ? Object.keys(given).filter((a) => given[a]) : []);
    const acts = MATRIX_ACTIONS.filter((a) => list.includes(a));
    if (acts.length) out[r.id] = acts;
  });
  return out;
}

// Which product roles a matrix fills.
function productsOfMatrix(matrix) {
  const has = (p) => MATRIX_ROWS.some((r) => r.product === p && (matrix[r.id] || []).length);
  return { hrms: has('hrms'), ats: has('ats'), accounts: has('accounts') };
}

// The RoleAccess rows a matrix stands for: [{ product, moduleId, moduleEnabled, features }].
function engineRowsFor(matrix) {
  const products = productsOfMatrix(matrix);
  const grid = {};
  MATRIX_MODULES.forEach((m) => { grid[m] = {}; });
  const grant = (moduleId, feature, action) => {
    grid[moduleId][feature] = grid[moduleId][feature] || {};
    grid[moduleId][feature][action] = true;
  };
  MATRIX_ROWS.forEach((r) => {
    const acts = matrix[r.id] || [];
    if (!acts.length) return;
    r.targets.forEach(([moduleId, feats]) => feats.forEach((f) => {
      if (moduleId === 'reports') {
        // A report follows its product: HRMS reports only for a role that
        // holds HRMS, and so on. A Reports-only role reaches no report.
        const p = REPORT_FEATURE_PRODUCT[f];
        if (p && !products[p]) return;
      }
      acts.forEach((a) => grant(moduleId, f, ACTION_TO_ENGINE[a]));
    }));
  });
  // An HRMS role that may VIEW anything in HRMS reaches the HRMS dashboard.
  const hrmsView = MATRIX_ROWS.some((r) => r.product === 'hrms' && (matrix[r.id] || []).includes('view'));
  if (hrmsView) HRMS_DASHBOARD_TARGETS.forEach(([m, feats]) => feats.forEach((f) => grant(m, f, 'view')));
  return MATRIX_MODULES.map((moduleId) => {
    const features = sanitizeFeatures(moduleId, grid[moduleId]);
    const enabled = Object.values(features).some((acts) => Object.values(acts).some(Boolean));
    return { product: productKeyOf(moduleId), moduleId, moduleEnabled: enabled, features };
  });
}

// AI Assistant & Agent for a NEW custom role — the same defaults the system
// roles get (permissions.js DEFAULT_RULES `ai` block): ask / voice / prompts,
// answers from the products its matrix covers, and agent create / edit when
// the matrix writes anything. Written once, at creation; afterwards it is
// edited on Role Catalog -> Edit Access like any module (the form never
// rewrites it).
const MATRIX_WRITE_ACTIONS = ['add', 'edit', 'delete', 'approve', 'reject', 'import'];
function aiRowFor(matrix) {
  const products = productsOfMatrix(matrix);
  const writes = Object.values(matrix || {}).some((acts) => (acts || []).some((a) => MATRIX_WRITE_ACTIONS.includes(a)));
  const grid = {
    'Ask the Assistant': { view: true },
    'Voice Input': { view: true },
    'Suggested Prompts': { view: true },
    'Answers from HRMS Data': { view: products.hrms },
    'Answers from ATS Data': { view: products.ats },
    'Answers from Accounts Data': { view: products.accounts },
    'Agent Actions': { create: writes, edit: writes },
  };
  return { product: productKeyOf('ai'), moduleId: 'ai', moduleEnabled: true, features: sanitizeFeatures('ai', grid) };
}

// The matrix a role's CURRENT engine access stands for — the "starting
// template" when copying a system role. A row's action is ticked when the
// role holds it on any of the row's features. `accessFor` is passed in to
// keep this file free of a require cycle with permissions.js.
async function matrixFromRole(role, accessFor) {
  const out = {};
  for (const r of MATRIX_ROWS) {
    const acts = [];
    for (const a of MATRIX_ACTIONS) {
      const engine = ACTION_TO_ENGINE[a];
      let held = false;
      for (const [moduleId, feats] of r.targets) {
        // eslint-disable-next-line no-await-in-loop
        const access = await accessFor(role, moduleId, productKeyOf(moduleId));
        if (access.moduleEnabled && feats.some((f) => access.features?.[f]?.[engine])) { held = true; break; }
      }
      if (held) acts.push(a);
    }
    if (acts.length) out[r.id] = acts;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage. Raw SQL on purpose: the table arrived by an additive migration and
// this must work whether or not the running Prisma client was regenerated.
// ---------------------------------------------------------------------------
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
function shape(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || null,
    status: row.status || 'Active',
    active: (row.status || 'Active') === 'Active',
    isSystem: !!Number(row.isSystem),
    external: EXTERNAL_ROLES.includes(row.code),
    scopeLevel: row.scopeLevel || 'OWN',
    behavesLike: parse(row.behavesLike, {}),
    permissions: parse(row.permissions, {}),
    products: parse(row.products, { hrms: false, ats: false, accounts: false }),
    position: Number(row.position) || 0,
    createdById: row.createdById || null,
    scopeDesc: ROLE_SCOPE_DESC[row.code] || SCOPE_LEVEL_LABEL[row.scopeLevel] || '—',
  };
}

let seeded = false;
async function ensureSystemRoles() {
  if (seeded) return;
  const now = Date.now();
  for (let i = 0; i < CATALOG_ROLES.length; i += 1) {
    const code = CATALOG_ROLES[i];
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "Role" ("id","code","name","description","status","isSystem","scopeLevel","position","createdAt","updatedAt")
       VALUES (?,?,?,?, 'Active', 1, ?, ?, ?, ?)`,
      `role_sys_${code.toLowerCase()}`, code, SYSTEM_ROLE_NAMES[code] || code, ROLE_SCOPE_DESC[code] || null,
      SYSTEM_SCOPE_LEVEL[code] || 'OWN', i, now, now,
    );
  }
  seeded = true;
}

let cache = null;
let cacheAt = 0;
const CACHE_MS = 15000;
function invalidateRoles() { cache = null; }

async function listRoles({ activeOnly = false } = {}) {
  if (!cache || Date.now() - cacheAt > CACHE_MS) {
    await ensureSystemRoles();
    const rows = await prisma.$queryRawUnsafe('SELECT * FROM "Role" ORDER BY "isSystem" DESC, "position" ASC, "name" ASC');
    cache = rows.map(shape);
    cacheAt = Date.now();
  }
  return activeOnly ? cache.filter((r) => r.active) : cache;
}

async function roleByCode(code) {
  if (!code) return null;
  return (await listRoles()).find((r) => r.code === code) || null;
}

// Is this a role code a login may be GIVEN now (active)? System roles always
// are — their status cannot be changed.
async function isAssignableRole(code) {
  const r = await roleByCode(code);
  return !!r && (r.isSystem || r.active);
}
// Is this a role code the engine / catalog knows at all (any status)?
async function isKnownRole(code) {
  return !!(await roleByCode(code));
}

// The scope alias for one product role (see the table at the top).
async function scopeAliasFor(code, product) {
  if (!code || code === 'NONE') return code;
  if (CATALOG_ROLES.includes(code)) return code;
  const r = await roleByCode(code);
  if (!r) return 'EMPLOYEE';
  if (product === 'ats' && r.behavesLike && BEHAVES_LIKE_ATS.includes(r.behavesLike.ats)) return r.behavesLike.ats;
  return (SCOPE_ALIAS[r.scopeLevel] || SCOPE_ALIAS.OWN)[product] || 'EMPLOYEE';
}

// A readable code for a new custom role: CUSTOM_SENIOR_RECRUITER (+ _2 …).
async function newRoleCode(name) {
  const base = `CUSTOM_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'ROLE'}`;
  const taken = new Set((await listRoles()).map((r) => r.code));
  let code = base;
  let n = 2;
  while (taken.has(code)) { code = `${base}_${n}`; n += 1; }
  return code;
}

async function insertRole(data) {
  const now = Date.now();
  const id = `role_${crypto.randomBytes(10).toString('hex')}`;
  const maxPos = (await listRoles()).reduce((m, r) => Math.max(m, r.position), 0);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Role" ("id","code","name","description","status","isSystem","scopeLevel","behavesLike","permissions","products","position","createdById","createdAt","updatedAt")
     VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?,?)`,
    id, data.code, data.name, data.description || null, data.status || 'Active', data.scopeLevel,
    JSON.stringify(data.behavesLike || {}), JSON.stringify(data.permissions || {}), JSON.stringify(data.products || {}),
    maxPos + 1, data.createdById || null, now, now,
  );
  invalidateRoles();
  return roleByCode(data.code);
}

async function updateRole(code, data) {
  const sets = [];
  const vals = [];
  const put = (col, v) => { sets.push(`"${col}" = ?`); vals.push(v); };
  if (data.name !== undefined) put('name', data.name);
  if (data.description !== undefined) put('description', data.description || null);
  if (data.status !== undefined) put('status', data.status);
  if (data.scopeLevel !== undefined) put('scopeLevel', data.scopeLevel);
  if (data.behavesLike !== undefined) put('behavesLike', JSON.stringify(data.behavesLike || {}));
  if (data.permissions !== undefined) put('permissions', JSON.stringify(data.permissions || {}));
  if (data.products !== undefined) put('products', JSON.stringify(data.products || {}));
  put('updatedAt', Date.now());
  vals.push(code);
  await prisma.$executeRawUnsafe(`UPDATE "Role" SET ${sets.join(', ')} WHERE "code" = ?`, ...vals);
  invalidateRoles();
  return roleByCode(code);
}

// ---------------------------------------------------------------------------
// ASSIGNING A ROLE TO A LOGIN (Add Employee -> Role).
//
// The designation still derives the baseline (all three product roles); the
// chosen Role then fills the product role(s) it is FOR and switches those
// products on:
//   * a custom role -> the products its matrix covers (role.products);
//   * a system role -> the products it is a working role in (below), and it
//     also becomes the account-level role, exactly as the old `role` override
//     did.
// ---------------------------------------------------------------------------
const SYSTEM_ROLE_PRODUCTS = {
  SUPER_ADMIN: ['hrms', 'ats', 'accounts'],
  ADMIN: ['hrms', 'ats', 'accounts'],
  MANAGER: ['hrms', 'ats'],
  ASSISTANT_MANAGER: ['hrms', 'ats'],
  STL: ['hrms', 'ats'],
  TL: ['hrms', 'ats'],
  HR: ['hrms'],
  RECRUITER: ['ats'],
  BDE: ['ats'],
  // + ats (role specs 2026-09-29): an Accountant reads the billing view of
  // Jobs / Requirements (joined candidates) and Clients, read-only.
  ACCOUNTANT: ['accounts', 'ats'],
  EMPLOYEE: ['hrms'],
};
// Roles only a globally-scoped caller (Super Admin / Admin / Manager-level)
// may hand out from Add Employee — the same rule the designation picker keeps.
const PRIVILEGED_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'];
function isPrivilegedRole(role) {
  if (!role) return false;
  if (role.isSystem) return PRIVILEGED_ROLES.includes(role.code);
  return role.scopeLevel === 'ALL';
}
function loginPatchForRole(role) {
  if (!role) return {};
  const products = role.isSystem
    ? (SYSTEM_ROLE_PRODUCTS[role.code] || [])
    : ['hrms', 'ats', 'accounts'].filter((p) => role.products && role.products[p]);
  const patch = {};
  products.forEach((p) => {
    patch[`${p}Role`] = role.code;
    patch[`${p}Access`] = true;
  });
  if (role.isSystem) patch.role = role.code;
  return patch;
}

// How many logins hold a role, in any product or as the account-level role.
async function holdersOf(code) {
  return prisma.user.count({
    where: { OR: [{ role: code }, { hrmsRole: code }, { atsRole: code }, { accountsRole: code }] },
  });
}

module.exports = {
  SYSTEM_ROLE_NAMES,
  EXTERNAL_ROLES,
  SCOPE_LEVELS,
  SCOPE_LEVEL_LABEL,
  SCOPE_ALIAS,
  BEHAVES_LIKE_ATS,
  MATRIX_ACTIONS,
  ACTION_TO_ENGINE,
  MATRIX_ROWS,
  MATRIX_MODULES,
  cleanMatrix,
  productsOfMatrix,
  engineRowsFor,
  aiRowFor,
  matrixFromRole,
  ensureSystemRoles,
  listRoles,
  invalidateRoles,
  roleByCode,
  isAssignableRole,
  isKnownRole,
  scopeAliasFor,
  newRoleCode,
  insertRole,
  updateRole,
  holdersOf,
  SYSTEM_ROLE_PRODUCTS,
  isPrivilegedRole,
  loginPatchForRole,
};
