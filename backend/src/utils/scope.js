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
// THE ASSIGNMENT CHAIN IS THE SCOPE.
//
//   Requirement -> Assigned TL -> Assigned Recruiter(s) -> BDE -> Client
//
// Recruiter: the requirements they are assigned — primary `recruiterId` or a
//   member of the comma-separated `recruiterIds` co-recruiter list.
// TL: the requirements they lead (`tlId`) plus their department's, which is
//   what "their team's" means for a TL who leads a desk rather than one req.
// STL: the same, one level up (`stlId` + assigned departments).
// BDE: their clients and the requirements they own (`bdeId`).
// Client: their own company, and never TeamLink's internal openings.
// Candidate: none — they reach requirements through their own applications.
//
// `recruiterIds` is matched with `contains` on a delimited string. The ids are
// cuids, so a substring collision is not a practical concern, but the value is
// stored comma-delimited WITH surrounding commas trimmed and `matches()` below
// implements `contains` identically, so a list query and a single-record check
// can never disagree.
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
      return { OR: [{ recruiterId: s.userId }, { recruiterIds: { contains: s.userId } }] };
    case 'BDE': {
      const or = [{ bdeId: s.userId }];
      if (s.clientIds.length) or.push({ clientId: { in: s.clientIds } });
      return { OR: or };
    }
    case 'TL': {
      const or = [{ tlId: s.userId }];
      if (s.departments.length) or.push({ department: { in: s.departments } });
      return { OR: or };
    }
    case 'STL': {
      const or = [{ stlId: s.userId }];
      if (s.departments.length) or.push({ department: { in: s.departments } });
      return { OR: or };
    }
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

// Is this user personally named on this requirement's assignment chain? Used
// for the EDIT / ASSIGN split: a TL can SEE a requirement in their department
// without being the person who may re-assign or edit it.
function isAssignedTo(user, requirement) {
  const s = scopeOf(user);
  if (!requirement) return false;
  const co = csv(requirement.recruiterIds);
  return requirement.recruiterId === s.userId
    || co.includes(s.userId)
    || requirement.tlId === s.userId
    || requirement.stlId === s.userId
    || requirement.bdeId === s.userId;
}

// --- Job Portal ------------------------------------------------------------
// The portal adds NO new scope rule. A user's portal rows are their
// requirement rows — requirementWhere() above, unchanged — optionally
// narrowed to the ones actually published. That is deliberate: if portal
// visibility had its own rule it could drift away from requirement
// visibility, and a Medical recruiter would end up seeing IT postings in one
// screen and not the other.
//
// A CLIENT's client-portal view is requirementWhere()'s client branch (own
// company, never TeamLink's internal openings) with the publish flag REPORTED
// per row rather than used as a filter: the client wants to know which of
// their requirements are out, which is not the same as hiding the ones that
// are not. `publishedOnly` exists for the one caller that does need it —
// scoped Sync, which can only push out what has actually been published.
function portalRequirementWhere(user, { publishedOnly = false } = {}) {
  const base = requirementWhere(user);
  return publishedOnly ? { ...base, portalPublished: true } : base;
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
  // A recruiter is scoped by their ASSIGNMENT, here as everywhere else: the
  // clients they actually hold a requirement for. They cannot raise a
  // requirement (see permissions.js SET.RAISE), so they have no reason to
  // browse the directory of clients they do not work on.
  if (s.atsRole === 'RECRUITER') {
    return { requirements: { some: requirementWhere(user) } };
  }
  // TL / STL / Manager reach the client directory — they CAN raise a
  // requirement, and it is the backing list for doing so. It carries no other
  // client's candidates, and each client's detail is still scope-checked.
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
// "A Client only sees candidates SHARED with that client."
//
// Reaching the client's requirement is not enough: a candidate sitting at
// Recruiter Review on a client's role has not been put in front of that client
// yet, and the client must not see them. These are the stages from the moment
// a profile is shared onward. routes/candidates.js applies this on top of
// applicationWhere(), and also treats an application that EVER reached one of
// these stages as shared — so a candidate the client themselves rejected does
// not vanish from their view, while one rejected internally beforehand never
// appears at all.
const CLIENT_SHARED_STAGES = [
  'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED',
  'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED',
  'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED',
];

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
    // `{ contains }` — the co-recruiter list. Same semantics as the Prisma
    // filter above it, so a record the list query returns is a record the
    // single-record check accepts, and vice versa.
    if (value && typeof value === 'object' && typeof value.contains === 'string') {
      return String(record[key] || '').includes(value.contains);
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
  portalRequirementWhere,
  isAssignedTo,
  clientWhere,
  applicationWhere,
  candidateWhere,
  CLIENT_SHARED_STAGES,
  invoiceWhere,
  employeeWhere,
  recordInScope,
  matches,
  OUT_OF_SCOPE,
};
