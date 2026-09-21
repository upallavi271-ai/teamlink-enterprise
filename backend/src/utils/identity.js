// ---------------------------------------------------------------------------
// Identity resolution.
//
// ONE EMPLOYEE = ONE USER = ONE LOGIN. An "ATS Recruiter" is not a separate
// record: it is the same employee, working in ATS because their designation
// maps to the RECRUITER role and their department supplies the scope.
//
// resolveIdentity() runs the whole login chain:
//   user -> Employee / Client / Candidate record -> product access -> role
//        -> department / team / scope -> landing page
// and produces the object that the JWT carries and that req.user holds.
// ---------------------------------------------------------------------------

const prisma = require('../db');

// Seeded fallback for the designation -> ATS role mapping, used only when the
// DesignationRole table is empty (fresh DB before seed). The real mapping is
// DATA in that table and is editable from Administration -> Users.
const FALLBACK_DESIGNATION_MAP = [
  { designation: 'Super Admin', atsRole: 'SUPER_ADMIN', hrms: true, ats: true, accounts: true, landing: 'ats' },
  { designation: 'Admin', atsRole: 'ADMIN', hrms: true, ats: true, accounts: true, landing: 'ats' },
  { designation: 'Manager', atsRole: 'MANAGER', hrms: true, ats: true, accounts: true, landing: 'ats' },
  { designation: 'Assistant Manager', atsRole: 'ASSISTANT_MANAGER', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'STL', atsRole: 'STL', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'Senior Team Lead', atsRole: 'STL', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'TL', atsRole: 'TL', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'Team Lead', atsRole: 'TL', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'Recruiter', atsRole: 'RECRUITER', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'Senior Recruiter', atsRole: 'RECRUITER', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'BDE', atsRole: 'BDE', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'Business Development Executive', atsRole: 'BDE', hrms: true, ats: true, accounts: false, landing: 'ats' },
  { designation: 'Accountant', atsRole: null, hrms: true, ats: false, accounts: true, landing: 'accounts' },
  { designation: 'HR Executive', atsRole: null, hrms: true, ats: false, accounts: false, landing: 'hrms' },
  { designation: 'Employee', atsRole: null, hrms: true, ats: false, accounts: false, landing: 'hrms' },
];

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
  return map.get(String(designation).trim().toLowerCase()) || null;
}

function csv(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Which workspace the user lands on. Never asks them to pick a role.
function landingFor(identity) {
  if (identity.landingWorkspace) return identity.landingWorkspace;
  if (identity.role === 'CANDIDATE') return 'candidate';
  if (identity.role === 'CLIENT') return 'client';
  if (identity.products.ats && identity.atsRole) return 'ats';
  if (identity.products.accounts) return 'accounts';
  if (identity.products.hrms) return 'hrms';
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

  // ATS working role: the per-user override, else the designation mapping,
  // else the login's own role code for logins that carry no employee record.
  const atsRole = user.atsRole
    || (mapping ? mapping.atsRole : null)
    || (['CLIENT', 'CANDIDATE'].includes(user.role) ? user.role : null);

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
    role: user.role,
    status: user.status || 'Active',

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
    atsDepartment: departments[0] || null,
    atsScopeDepartments: departments.join(','),
    atsScopeTeams: teams.join(','),
    atsScopeClients: user.atsScopeClients || '',
    landingWorkspace: user.landingWorkspace || (mapping ? mapping.landing : null) || null,
  };
  identity.workspace = landingFor(identity);
  identity.landingPath = WORKSPACE_HOME[identity.workspace] || '/';
  // Which workspaces this login can switch between — never a role picker.
  identity.workspaces = [
    products.ats && atsRole ? { id: 'ats', label: 'ATS', path: WORKSPACE_HOME.ats } : null,
    products.hrms ? { id: 'hrms', label: 'HRMS', path: WORKSPACE_HOME.hrms } : null,
    products.accounts ? { id: 'accounts', label: 'Accounts', path: WORKSPACE_HOME.accounts } : null,
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
    atsRole: identity.atsRole,
    products: identity.products,
    workspace: identity.workspace,
  };
}

module.exports = {
  resolveIdentity,
  tokenPayload,
  mappingFor,
  designationMap,
  invalidateDesignationMap,
  FALLBACK_DESIGNATION_MAP,
  WORKSPACE_HOME,
};
