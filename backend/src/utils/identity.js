// ---------------------------------------------------------------------------
// Identity resolution.
//
// ONE EMPLOYEE = ONE USER = ONE LOGIN. An "ATS Recruiter" is not a separate
// record: it is the same employee, working in ATS because their designation
// maps to the RECRUITER role and their department supplies the scope.
//
// resolveIdentity() runs the whole login chain:
//   user -> Employee / Client / Candidate record -> product access
//        -> THE THREE PRODUCT ROLES -> department / team / scope -> landing
// and produces the object that the JWT carries and that req.user holds.
//
// ONE LOGIN, THREE INDEPENDENT PRODUCT ROLES:
//
//   USER
//    ├── HRMS Role      → hrmsRole
//    ├── ATS Role       → atsRole
//    └── Accounts Role  → accountsRole
//
// Different people hold different combinations — HRMS Manager + ATS TL, or
// HRMS Employee + ATS None + Accounts Accountant, or HRMS Employee + ATS
// Recruiter. Each is DERIVED from the designation through the DesignationRole
// table (never a switch statement, and never a compound name: "Medical
// Recruiter" does not exist — that is department=Medical + atsRole=RECRUITER)
// and may be overridden per user on Administration → Users.
// ---------------------------------------------------------------------------

const prisma = require('../db');

// Seeded fallback for the designation -> ATS role mapping, used only when the
// DesignationRole table is empty (fresh DB before seed). The real mapping is
// DATA in that table and is editable from Administration -> Users.
// Each row carries ALL THREE product roles. hrmsRole/accountsRole are left
// implicit here and filled in by normaliseMapping() below with the same rule
// the migration backfilled the table with, so the fallback and the table can
// never disagree.
// THE EIGHT EMPLOYEE ROLES.
//
// RECRUITER IS NOT ONE OF THEM. A recruiter is an EMPLOYEE who also holds
// the ATS product role Recruiter — one person, one employee record, one
// login, with the ATS role added on Administration -> Users. Listing
// "Recruiter" here would have made it an employee role and invited a second
// record for the same person, which is the exact thing this model exists to
// prevent. BDE is absent for the same reason.
//
// The product columns are the permitted PRODUCTS. What a person can do
// inside one is still decided by their role for THAT product, so an Employee
// with no ATS role reaches ATS and finds their own nothing until somebody
// makes them a Recruiter.
const FALLBACK_DESIGNATION_MAP = [
  { designation: 'Super Admin', atsRole: 'SUPER_ADMIN', hrms: true, ats: true, accounts: true, landing: 'ats' },
  { designation: 'HR', hrmsRole: 'HR', atsRole: 'HR', hrms: true, ats: true, accounts: false, landing: 'hrms' },
  { designation: 'Manager', atsRole: 'MANAGER', hrms: true, ats: true, accounts: true, landing: 'ats' },
  { designation: 'Assistant Manager', atsRole: 'ASSISTANT_MANAGER', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'STL', atsRole: 'STL', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'TL', atsRole: 'TL', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'Employee', hrmsRole: 'EMPLOYEE', atsRole: null, hrms: true, ats: true, accounts: false, landing: 'hrms' },
  { designation: 'Accountant', hrmsRole: 'NONE', atsRole: null, hrms: false, ats: false, accounts: true, landing: 'accounts' },
];

const NO_ROLE = 'NONE';
const named = (v) => (v && v !== NO_ROLE ? v : null);

// The login role a designation implies when the mapping row does not name one
// explicitly: its ATS role, or ACCOUNTANT for an accounts-only designation,
// or a plain EMPLOYEE. Exactly the rule the prodrole migration backfilled
// DesignationRole.hrmsRole / accountsRole with.
function impliedRole(row) {
  if (row.atsRole) return row.atsRole;
  if (row.accounts && !row.ats) return 'ACCOUNTANT';
  return 'EMPLOYEE';
}

// A mapping row with all three product roles resolved.
function normaliseMapping(row) {
  if (!row) return null;
  const implied = impliedRole(row);
  return {
    ...row,
    hrmsRole: named(row.hrmsRole) || (row.hrms ? implied : NO_ROLE),
    atsRole: named(row.atsRole) || NO_ROLE,
    accountsRole: named(row.accountsRole) || (row.accounts ? implied : NO_ROLE),
  };
}

let mapCache = null;
let mapCacheAt = 0;
const MAP_CACHE_MS = 15000;

function invalidateDesignationMap() { mapCache = null; }

async function designationMap() {
  if (mapCache && Date.now() - mapCacheAt < MAP_CACHE_MS) return mapCache;
  let rows = [];
  try {
    rows = await prisma.designationRole.findMany({ orderBy: { position: 'asc' } });
  } catch {
    rows = [];
  }
  if (!rows.length) rows = FALLBACK_DESIGNATION_MAP;
  const byName = new Map();
  rows.forEach((r) => byName.set(String(r.designation).trim().toLowerCase(), r));
  mapCache = byName;
  mapCacheAt = Date.now();
  return mapCache;
}

// Designation -> ATS role. Configurable data, never a switch statement, and
// department-agnostic: the same "TL" row serves Medical, IT and everyone else.
async function mappingFor(designation) {
  if (!designation) return null;
  const map = await designationMap();
  return normaliseMapping(map.get(String(designation).trim().toLowerCase()) || null);
}

function csv(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Which workspace the user lands on. Never asks them to pick a role.
// The landing page follows THE PRODUCT ROLES: a product with no role in it is
// not somewhere this login can land, however the product boolean reads.
function landingFor(identity) {
  if (identity.landingWorkspace) return identity.landingWorkspace;
  if (identity.role === 'CANDIDATE') return 'candidate';
  if (identity.role === 'CLIENT') return 'client';
  if (identity.products.ats && named(identity.atsRole)) return 'ats';
  if (identity.products.accounts && named(identity.accountsRole)) return 'accounts';
  if (identity.products.hrms && named(identity.hrmsRole)) return 'hrms';
  return 'hrms';
}

const WORKSPACE_HOME = {
  ats: '/ats/dashboard',
  accounts: '/accounts/dashboard',
  hrms: '/hrms',
  client: '/ats/dashboard',
  candidate: '/my-applications',
};

// The full resolved identity. Everything downstream — guards, scope, nav —
// reads this and nothing else.
async function resolveIdentity(userId, preloaded = null) {
  const user = preloaded || await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const employee = await prisma.employee.findUnique({ where: { userId: user.id } }).catch(() => null);
  const mapping = await mappingFor(employee ? employee.designation : null);

  // Product access: the stored booleans win. The designation mapping only
  // fills in a login that predates them and has none set.
  let products = {
    hrms: !!user.hrmsAccess,
    ats: !!user.atsAccess,
    accounts: !!user.accountsAccess,
  };
  if (!products.hrms && !products.ats && !products.accounts && mapping) {
    products = { hrms: !!mapping.hrms, ats: !!mapping.ats, accounts: !!mapping.accounts };
  }

  // ------------------------------------------------------------------
  // THE THREE PRODUCT ROLES.
  //
  // For each product, in order: the per-user override, then the designation
  // mapping, then — for a login that predates the columns or carries no
  // employee record — the account-level `role`, which is exactly what the
  // engine resolved against before this model existed. 'NONE' where the
  // product is not held, which the engine refuses outright.
  // ------------------------------------------------------------------
  const productRole = (product, stored) => {
    if (!products[product]) return NO_ROLE;
    // An explicit 'NONE' on the user is a REFUSAL an administrator typed. It
    // is not the same as an empty column, which simply falls back.
    if (stored === NO_ROLE) return NO_ROLE;
    return stored
      || (mapping ? named(mapping[`${product}Role`]) : null)
      || user.role
      || NO_ROLE;
  };
  const hrmsRole = productRole('hrms', user.hrmsRole);
  const accountsRole = productRole('accounts', user.accountsRole);
  // The ATS role keeps its extra step: an external CLIENT / CANDIDATE login
  // carries no employee record and no designation, so its account kind is its
  // ATS role.
  const atsRole = (!products.ats || user.atsRole === NO_ROLE)
    ? NO_ROLE
    : (user.atsRole
      || (mapping ? named(mapping.atsRole) : null)
      || (['CLIENT', 'CANDIDATE'].includes(user.role) ? user.role : null)
      || user.role
      || NO_ROLE);

  // Scope. Stored overrides win; otherwise the employee's own department/team.
  const departments = csv(user.atsScopeDepartments).length
    ? csv(user.atsScopeDepartments)
    : [user.atsDepartment || (employee && employee.department)].filter(Boolean);
  const teams = csv(user.atsScopeTeams).length
    ? csv(user.atsScopeTeams)
    : [user.team || (employee && employee.team)].filter(Boolean);

  const identity = {
    id: user.id,
    email: user.email,
    name: user.name,
    // The ACCOUNT-LEVEL / system role: Super Admin, Admin, and the external
    // CLIENT / CANDIDATE account kinds. Route guards never read it directly;
    // it is one of the roles the product-agnostic modules resolve against.
    role: user.role,
    status: user.status || 'Active',

    // The three product roles. THESE are what the engine resolves against.
    hrmsRole,
    accountsRole,

    employeeId: employee ? employee.id : null,
    employeeCode: employee ? employee.employeeCode : null,
    department: employee ? employee.department : (user.atsDepartment || null),
    team: employee ? employee.team : (user.team || null),
    designation: employee ? employee.designation : null,
    reportingManagerId: employee ? employee.reportingManagerId : null,
    employmentStatus: employee ? employee.employmentStatus : null,

    clientId: user.clientId || null,
    candidateId: user.candidateId || null,

    products,
    atsRole,
    productRoles: { hrms: hrmsRole, ats: atsRole, accounts: accountsRole },
    atsDepartment: departments[0] || null,
    atsScopeDepartments: departments.join(','),
    atsScopeTeams: teams.join(','),
    atsScopeClients: user.atsScopeClients || '',
    landingWorkspace: user.landingWorkspace || (mapping ? mapping.landing : null) || null,
  };
  identity.workspace = landingFor(identity);
  identity.landingPath = WORKSPACE_HOME[identity.workspace] || '/';
  // Which workspaces this login can switch between — never a role picker.
  //
  // THE SWITCHER IS A SURFACE AN EXTERNAL LOGIN CAN SEE, so the labels it
  // carries are role-dependent. "HRMS" is internal vocabulary: a Client or a
  // Candidate must never be handed it, even in the unlikely event somebody
  // grants one of them the product by mistake.
  const external = ['CLIENT', 'CANDIDATE'].includes(identity.role) || ['CLIENT', 'CANDIDATE'].includes(atsRole);
  const label = (id, internalLabel, externalLabel) => (external ? externalLabel : internalLabel);
  // A workspace is offered only where the login actually HOLDS A ROLE in that
  // product — accountsRole = None means no Accounts tab, however senior the
  // HRMS or ATS role is.
  identity.workspaces = [
    products.ats && named(atsRole) ? { id: 'ats', label: label('ats', 'ATS', 'Recruitment'), path: WORKSPACE_HOME.ats } : null,
    products.hrms && named(hrmsRole) ? { id: 'hrms', label: label('hrms', 'HRMS', 'My Workspace'), path: WORKSPACE_HOME.hrms } : null,
    products.accounts && named(accountsRole) ? { id: 'accounts', label: label('accounts', 'Accounts', 'Billing'), path: WORKSPACE_HOME.accounts } : null,
  ].filter(Boolean);
  return identity;
}

// The compact form that rides in the JWT. Kept small, and re-resolved from the
// database on every request anyway (see middleware/auth.js) so that revoking
// access takes effect immediately rather than in eight hours.
function tokenPayload(identity) {
  return {
    id: identity.id,
    email: identity.email,
    name: identity.name,
    role: identity.role,
    employeeId: identity.employeeId,
    clientId: identity.clientId,
    candidateId: identity.candidateId,
    hrmsRole: identity.hrmsRole,
    atsRole: identity.atsRole,
    accountsRole: identity.accountsRole,
    products: identity.products,
    workspace: identity.workspace,
  };
}

module.exports = {
  NO_ROLE,
  impliedRole,
  normaliseMapping,
  resolveIdentity,
  tokenPayload,
  mappingFor,
  designationMap,
  invalidateDesignationMap,
  FALLBACK_DESIGNATION_MAP,
  WORKSPACE_HOME,
};
