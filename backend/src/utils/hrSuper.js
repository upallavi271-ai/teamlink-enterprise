// ---------------------------------------------------------------------------
// INTERNAL HR  "HR SUPER ACCESS"  (founder, 2026-10-14)
//
//   "PurnaChandra Sekhar (TL309) and T Divya Sri Sivatmika will work as INTERNAL HR.
//    They can see everyone's attendance, leaves and payroll. Both have ALL access like
//    a Super Admin, but whenever they DELETE, EXPORT or IMPORT something, a NOTIFICATION
//    goes out."                                    (supersedes the 2026-10-10 floor-HR limits)
//
// ONE place decides it. A login holds the access when
//   * it is on the list in the AppSetting 'hr-super-access'  (Administration -> Audit logs
//     -> HR sensitive actions -> "Who has HR super access", or the data script), OR
//   * one of its product roles is the Role Catalog role "Internal HR" (code CUSTOM_INTERNAL_HR).
// Nobody is hard-coded. A real Super Admin, a client or a candidate never is a member.
//
// HOW: utils/identity.js calls escalate() as the LAST step of resolveIdentity(), so the whole
// permission engine (can(), effectiveMatrix(), scope.js, the nav, hundreds of route checks)
// sees a Super Admin. The login keeps its STORED roles (a TL stays a TL in the database); the
// real ones ride along in identity.hrSuper. Everything a delegate must NOT be able to do (it
// would let them grant themselves unlimited power) is refused here, in GUARDS, from the one
// guard layer middleware/auth.js requireAuth -> checkRequest(). Add a row to GUARDS to keep
// one more thing Super-Admin-only; delete a row to widen it.
//
// Alerts for delete / export / import: utils/hrSensitiveAlert.js (keyed on identity.hrSuper).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ROLE_CODE = 'CUSTOM_INTERNAL_HR';
const ROLE_NAME = 'Internal HR';
const SETTINGS_KEY = 'hr-super-access';
const DEFAULTS = Object.freeze({ enabled: true, users: [], emailSuperAdmins: true, notifyAdmins: false });
const ROLE_FIELDS = ['role', 'hrmsRole', 'atsRole', 'accountsRole'];

// ---- switches / list -------------------------------------------------------
let cache = null;
let cacheAt = 0;
const CACHE_MS = 8000;
function invalidate() { cache = null; }

function clean(v) {
  const o = v && typeof v === 'object' ? v : {};
  const users = Array.isArray(o.users) ? o.users : [];
  const seen = new Set();
  return {
    enabled: o.enabled !== false,
    emailSuperAdmins: o.emailSuperAdmins !== false,
    notifyAdmins: o.notifyAdmins === true,
    users: users
      .map((u) => (typeof u === 'string' ? { id: u } : u))
      .filter((u) => u && u.id && !seen.has(u.id) && seen.add(u.id))
      .map((u) => ({
        id: String(u.id),
        name: u.name ? String(u.name) : null,
        employeeCode: u.employeeCode ? String(u.employeeCode) : null,
        addedAt: u.addedAt || null,
        addedBy: u.addedBy || null,
      })),
  };
}
async function settings() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  let v = {};
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    v = row ? JSON.parse(row.value) : {};
  } catch { v = {}; }
  cache = clean(v);
  cacheAt = Date.now();
  return cache;
}
async function saveSettings(next, user) {
  const value = JSON.stringify(clean(next));
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  invalidate();
  return settings();
}

// ---- who holds it ----------------------------------------------------------
// user: the User row; employee: the linked Employee row (or null).
// Returns null or { member, via, label, real: { role, hrmsRole, atsRole, accountsRole } }.
async function resolveFor(user, employee) {
  if (!user) return null;
  if (['SUPER_ADMIN', 'ADMIN', 'CLIENT', 'CANDIDATE'].includes(user.role) || ['SUPER_ADMIN', 'ADMIN'].includes(user.hrmsRole)) return null;
  if (employee && ['Relieved', 'Exited'].includes(employee.employmentStatus)) return null;
  const cfg = await settings();
  if (!cfg.enabled) return null;
  const listed = cfg.users.some((u) => u.id === user.id);
  const byRole = ROLE_FIELDS.some((f) => user[f] === ROLE_CODE);
  if (!listed && !byRole) return null;
  return {
    member: true,
    via: listed ? 'list' : 'role',
    label: ROLE_NAME,
    real: { role: user.role, hrmsRole: user.hrmsRole || null, atsRole: user.atsRole || null, accountsRole: user.accountsRole || null },
  };
}

// The Super-Admin-equivalent identity. Called once, at the end of resolveIdentity().
function escalate(identity, info) {
  if (!identity || !info) return identity;
  const SA = 'SUPER_ADMIN';
  identity.hrSuper = info;
  identity.role = SA;
  identity.hrmsRole = SA;
  identity.atsRole = SA;
  identity.accountsRole = SA;
  identity.products = { hrms: true, ats: true, accounts: true };
  identity.productRoles = { hrms: SA, ats: SA, accounts: SA };
  identity.scopeRoles = { hrms: SA, ats: SA, accounts: SA };
  identity.internalHr = null; // the floor-HR overlay (utils/internalHr.js) is replaced by this
  identity.hrDesk = false; // not limited to internal hiring
  identity.atsTeamUserIds = null;
  identity.hrmsTeamScope = null;
  identity.atsPositionScope = null;
  identity.atsOwnedClientIds = null;
  identity.atsBdeDeskDepartments = null;
  identity.atsBdeDeskRequirementDepartments = null;
  identity.atsBdeUnownedClientIds = null;
  identity.atsDeptClientDepartments = null;
  identity.atsJoinedRequirementIds = null;
  identity.systemAccount = false; // still an employee: own attendance, leave, payslip
  identity.workspaces = [
    { id: 'ats', label: 'ATS', path: '/ats/dashboard' },
    { id: 'hrms', label: 'HRMS', path: '/hrms' },
    { id: 'accounts', label: 'Accounts', path: '/accounts/dashboard' },
  ];
  return identity;
}

// ---- tests on a resolved identity (req.user) -------------------------------
const isHrSuper = (u) => !!(u && u.hrSuper);
// A REAL Super Admin: the role, and not a delegate who only looks like one.
const isRealSuper = (u) => !!u && u.role === 'SUPER_ADMIN' && !u.hrSuper;
// Real Super Admin or Admin: the people who may hand this access out.
const isRealTop = (u) => !!u && !u.hrSuper && ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
// The role fields as STORED (an HR-super login is a TL / HR in the database).
const realRolesOf = (u) => (u && u.hrSuper ? u.hrSuper.real : u ? { role: u.role, hrmsRole: u.hrmsRole, atsRole: u.atsRole, accountsRole: u.accountsRole } : {});

// ---- THE GUARDS: kept Super-Admin-only -------------------------------------
// Each: id, label (plain words), why, test(method, path) over the path RELATIVE to /api.
// Row-level guards (a Super Admin account as the target of an edit) are in checkTargets().
const NOT_GET = (m) => m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
const GUARDS = [
  {
    id: 'role-catalog',
    label: 'Role Catalog and the permission matrix',
    why: 'Whoever edits what each role may do could give themselves, or anybody, unlimited power.',
    test: (m, p) => NOT_GET(m) && /^\/admin\/(role-catalog|designation-roles)(\/|$)/.test(p),
  },
  {
    id: 'security-settings',
    label: 'Security settings (password rules, sign-in lock, sessions, password alerts)',
    why: 'These protect every login, including the Super Admin\'s. A delegate must not be able to loosen them.',
    test: (m, p) => NOT_GET(m) && /^\/admin\/(password-alert-setting|security)(\/|$)/.test(p),
  },
  {
    id: 'integration-secrets',
    label: 'Integration credentials (job portal, WhatsApp, SMS, e-mail, AI keys)',
    why: 'Replacing or switching off a channel\'s credentials can redirect or read every outgoing message.',
    test: (m, p) => NOT_GET(m) && /^\/admin\/integrations\/[^/]+\/(configure|connect|disconnect)\/?$/.test(p),
  },
  {
    id: 'view-as-act-as',
    label: 'View as / Act as another login',
    why: 'Acting as someone else is how a delegate could use another person\'s (or the Super Admin\'s) rights without their name on it.',
    test: (m, p) => /^\/admin\/view-as(\/|$)/.test(p),
  },
  {
    id: 'backups-restore',
    label: 'Backups, restore and database tools',
    why: 'A restore replaces the whole company database, including the access settings themselves.',
    test: (m, p) => NOT_GET(m) && /^\/system(\/|$)/.test(p),
  },
  {
    id: 'exit-settings',
    label: 'Exit approval settings (who finally approves an exit)',
    why: 'Who finally approves an exit is the Super Admin\'s decision. Relieving someone directly without approval is open to HR and Internal HR since 15 Oct 2026 (while the Admin switch "Let HR relieve an employee directly" is On); that is no longer on this list.',
    test: (m, p) => NOT_GET(m) && /^\/(exit-center\/settings|resignations\/exit\/settings)\/?$/.test(p),
  },
  {
    id: 'hr-super-list',
    label: 'Who has HR super access (this list)',
    why: 'Only a Super Admin or an Admin hands this access out; a holder cannot add people or widen their own.',
    test: (m, p) => NOT_GET(m) && /^\/admin\/hr-super-access(\/|$)/.test(p),
  },
];

// Things a guard cannot see in the path: rows. Returns a plain sentence or null.
// "A Super Admin account" = any login that holds Super Admin or Admin (Admin also guards the keys to the product).
const TOP = ['SUPER_ADMIN', 'ADMIN'];
async function checkTargets(user, method, p) {
  if (!NOT_GET(method)) return null;
  const mUser = p.match(/^\/admin\/users\/([^/]+)(\/|$)/);
  const mEmp = p.match(/^\/employees\/(?:management\/)?([^/]+)(\/|$)/);
  let target = null;
  if (mUser && mUser[1] !== 'employees-without-login' && mUser[1] !== 'starting-password') {
    target = await prisma.user.findUnique({ where: { id: mUser[1] }, select: { id: true, role: true, hrmsRole: true, atsRole: true, accountsRole: true, name: true } }).catch(() => null);
  } else if (mEmp && !['export', 'bulk-import', 'management', 'me', 'import', 'tl-wise', 'tl-wise.xlsx', 'export.xlsx', 'global'].includes(mEmp[1])) {
    const e = await prisma.employee.findUnique({ where: { id: mEmp[1] }, select: { user: { select: { id: true, role: true, hrmsRole: true, atsRole: true, accountsRole: true, name: true } } } }).catch(() => null);
    target = e && e.user ? e.user : null;
  }
  if (!target) return null;
  if (target.id === user.id) {
    // Their own access profile: nothing that touches their own login's roles, status, password or sign-in.
    if (/\/(roles|toggle-status|toggle-login|reset-password|reset-link|password|set-password|send-password-reset|create-login)(\/|$)/.test(p)
      || (mUser && method === 'PUT' && !/\/(reset|toggle)/.test(p))) {
      return 'You cannot change your own access or login. Ask a Super Admin.';
    }
    return null;
  }
  if (ROLE_FIELDS.some((f) => TOP.includes(target[f]))) {
    return 'Only a Super Admin can change a Super Admin or Admin account (edit, switch off, delete, password, roles).';
  }
  return null;
}

const pathOf = (req) => String((req && (req.originalUrl || req.url)) || '').split('?')[0].replace(/^\/api(?=\/|$)/, '');

// Called by middleware/auth.js requireAuth for an HR-super login only.
// Returns null (go on) or { status, error, guard }.
async function checkRequest(req, user) {
  const method = String(req.method || 'GET').toUpperCase();
  const p = pathOf(req);
  for (const g of GUARDS) {
    if (g.test(method, p)) return { status: 403, error: `${g.label}: only the Super Admin can do this. ${g.why}`, guard: g.id };
  }
  const why = await checkTargets(user, method, p);
  if (why) return { status: 403, error: why, guard: 'super-admin-account' };
  return null;
}

// The list the screen and the report show.
function guardList() {
  return [
    ...GUARDS.map((g) => ({ id: g.id, label: g.label, why: g.why })),
    { id: 'super-admin-account', label: 'Super Admin and Admin accounts (edit, switch off, delete, passwords, roles) and your own access', why: 'A delegate must not be able to lock out, impersonate or promote themselves above the Super Admin.' },
    { id: 'assign-roles', label: 'Giving the Admin / Super Admin / Internal HR role to anyone', why: 'Same reason: handing out power is the Super Admin\'s and Admin\'s alone.' },
    { id: 'audit-append-only', label: 'Deleting audit logs', why: 'The audit trail is append-only for everyone; no screen deletes it.' },
  ];
}

// ---- the Role Catalog row --------------------------------------------------
// Creates the role "Internal HR" (all ticks) in the registry if it is missing, so it appears in the
// Role Catalog and in every role picker. Idempotent. Returns { created, role }.
async function ensureRole(actor) {
  const registry = require('./roleRegistry'); // eslint-disable-line global-require
  const existing = await registry.roleByCode(ROLE_CODE);
  if (existing) return { created: false, role: existing };
  const all = {};
  registry.MATRIX_ROWS.forEach((r) => { all[r.id] = registry.MATRIX_ACTIONS.slice(); });
  const permissions = registry.cleanMatrix(all);
  const role = await registry.insertRole({
    code: ROLE_CODE,
    name: ROLE_NAME,
    description: 'Company-wide access like a Super Admin, without the privilege-escalation and security guards. Every delete, export and import is reported to the Super Admins.',
    status: 'Active',
    scopeLevel: 'ALL',
    behavesLike: {},
    permissions,
    products: registry.productsOfMatrix(permissions),
    createdById: actor ? actor.id : null,
  });
  const { invalidateRoleAccess } = require('./permissions'); // eslint-disable-line global-require
  for (const row of registry.engineRowsFor(permissions)) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.roleAccess.upsert({
      where: { role_product_moduleId: { role: ROLE_CODE, product: row.product, moduleId: row.moduleId } },
      create: { role: ROLE_CODE, product: row.product, moduleId: row.moduleId, moduleEnabled: row.moduleEnabled, features: JSON.stringify(row.features) },
      update: { moduleEnabled: row.moduleEnabled, features: JSON.stringify(row.features) },
    });
  }
  if (typeof invalidateRoleAccess === 'function') invalidateRoleAccess(ROLE_CODE);
  return { created: true, role };
}

module.exports = {
  ROLE_CODE, ROLE_NAME, SETTINGS_KEY, DEFAULTS, ROLE_FIELDS, GUARDS,
  settings, saveSettings, invalidate, clean, resolveFor, escalate,
  isHrSuper, isRealSuper, isRealTop, realRolesOf, checkRequest, checkTargets, guardList, ensureRole, pathOf,
};
