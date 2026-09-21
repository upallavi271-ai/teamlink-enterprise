// ---------------------------------------------------------------------------
// Data scope — step 6/7 of the permission engine.
//
// Visibility is never role alone. It is
//   user + product + role + department + team + client + ownership + permission.
//
// Everything here runs ON THE SERVER and produces Prisma `where` fragments that
// list endpoints must spread in. A hidden button is not access control; the
// frontend hides UI from the same model, but these functions are what actually
// refuses a request.
//
// This replaces the old DEPT_SCOPED_ROLES / isDeptScopedRole helper and the
// ad-hoc `user.role === 'CLIENT'` filters that were scattered across routes.
// ---------------------------------------------------------------------------

// Roles that see everything, always.
const GLOBAL_SCOPE_ROLES = ['SUPER_ADMIN', 'ADMIN'];
// Manager and Assistant Manager are cross-department by DEFAULT, but their
// scope is CONFIGURED: give one an explicit department list on
// Administration -> Users and they are held to it, like any other role.
const CONFIGURABLE_GLOBAL_ROLES = ['MANAGER', 'ASSISTANT_MANAGER'];

function csv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// The resolved scope for a user. `identity.js` puts these fields on req.user.
function scopeOf(user) {
  const u = user || {};
  const departments = csv(u.atsScopeDepartments).length
    ? csv(u.atsScopeDepartments)
    : (u.department ? [u.department] : []);
  const teams = csv(u.atsScopeTeams).length ? csv(u.atsScopeTeams) : (u.team ? [u.team] : []);
  const configuredGlobal = CONFIGURABLE_GLOBAL_ROLES.includes(u.role)
    && !csv(u.atsScopeDepartments).length;
  return {
    global: GLOBAL_SCOPE_ROLES.includes(u.role) || configuredGlobal,
    role: u.role,
    atsRole: u.atsRole || u.role,
    userId: u.id,
    departments,
    teams,
    clientId: u.clientId || null,
    clientIds: csv(u.atsScopeClients),
    candidateId: u.candidateId || null,
    employeeId: u.employeeId || null,
  };
}

// --- Requirements ----------------------------------------------------------
// Recruiter: own assigned requirements. TL: own department (and team where the
// requirement records one). STL: assigned departments. BDE: own clients and own
// assigned requirements. Client: own company. Candidate: none (they reach
// requirements only through their own applications).
function requirementWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  switch (s.atsRole) {
    case 'CLIENT':
      // Own company only — and never TeamLink's own internal openings, which
      // are stored against a client but are not that client's work.
      return { clientId: s.clientId || '__none__', internal: false };
    case 'CANDIDATE':
      return { id: '__none__' };
    case 'RECRUITER':
      return { recruiterId: s.userId };
    case 'BDE': {
      const or = [{ bdeId: s.userId }];
      if (s.clientIds.length) or.push({ clientId: { in: s.clientIds } });
      return { OR: or };
    }
    case 'TL':
    case 'STL':
    case 'MANAGER':
    case 'ASSISTANT_MANAGER':
      // Department-scoped. A Manager with no configured departments is global
      // and never reaches this branch (see scopeOf).
      return s.departments.length ? { department: { in: s.departments } } : { id: '__none__' };
    default:
      // Employees / accountants with no ATS working role see no requirements.
      return { id: '__none__' };
  }
}

// --- Clients ---------------------------------------------------------------
function clientWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  if (s.role === 'CLIENT') return { id: s.clientId || '__none__' };
  if (s.role === 'CANDIDATE') return { id: '__none__' };
  // A BDE is scoped to the clients assigned to them; where none are assigned
  // they fall back to the clients they hold a requirement for.
  if (s.atsRole === 'BDE') {
    return s.clientIds.length
      ? { id: { in: s.clientIds } }
      : { requirements: { some: requirementWhere(user) } };
  }
  // Other internal staff reach the client directory — it is the backing list
  // for creating a requirement, and it carries no other client's candidates.
  return {};
}

// --- Applications / pipeline / interviews ----------------------------------
// One shared rule: an application is visible when its requirement is, or when
// it belongs to the signed-in candidate.
function applicationWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  if (s.atsRole === 'CANDIDATE' || s.role === 'CANDIDATE') {
    return { candidateId: s.candidateId || '__none__' };
  }
  return { requirement: requirementWhere(user) };
}

// --- Candidates ------------------------------------------------------------
// A candidate record is reachable when the user can reach one of its
// applications. Candidates themselves see only their own record.
function candidateWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  if (s.role === 'CANDIDATE') return { id: s.candidateId || '__none__' };
  return { applications: { some: applicationWhere(user) } };
}

// --- Invoices --------------------------------------------------------------
function invoiceWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  if (s.role === 'ACCOUNTANT') return {};
  if (s.role === 'CLIENT') return { clientId: s.clientId || '__none__' };
  return { id: '__none__' };
}

// --- Employees -------------------------------------------------------------
// HR roles see their scope's employees; everyone else sees only themselves.
function employeeWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  if (['STL', 'TL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.role) && s.departments.length) {
    return { department: { in: s.departments } };
  }
  return { id: s.employeeId || '__none__' };
}

// --- Record-level check, used by can(..., record) and by detail endpoints ---
function recordInScope(user, moduleId, record) {
  const s = scopeOf(user);
  if (s.global) return true;
  if (!record) return false;

  switch (moduleId) {
    case 'requirements':
      return matches(record, requirementWhere(user));
    case 'clients':
      if (s.atsRole === 'CLIENT') return record.id === s.clientId;
      return true;
    case 'candidates':
      if (s.role === 'CANDIDATE') return record.id === s.candidateId;
      return true;
    case 'accounts':
      if (s.role === 'CLIENT') return record.clientId === s.clientId;
      return true;
    default:
      return true;
  }
}

// Tiny evaluator for the simple `where` shapes this file produces, so the same
// rule serves both a list query and a single-record check.
function matches(record, where) {
  if (!where || Object.keys(where).length === 0) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((w) => matches(record, w));
    if (key === 'AND') return value.every((w) => matches(record, w));
    if (value && typeof value === 'object' && Array.isArray(value.in)) {
      return value.in.includes(record[key]);
    }
    if (value && typeof value === 'object') return true; // nested relation — checked by the query
    return record[key] === value;
  });
}

// One place to phrase a scope refusal, so every endpoint answers the same way.
const OUT_OF_SCOPE = { error: 'This record is outside your access scope' };

module.exports = {
  GLOBAL_SCOPE_ROLES,
  CONFIGURABLE_GLOBAL_ROLES,
  scopeOf,
  requirementWhere,
  clientWhere,
  applicationWhere,
  candidateWhere,
  invoiceWhere,
  employeeWhere,
  recordInScope,
  matches,
  OUT_OF_SCOPE,
};
