// ---------------------------------------------------------------------------
// Data scope — step 6/7 of the permission engine.
//
// Visibility is never role alone. It is
//   user + product + PRODUCT ROLE + department + team + client + ownership
//   + permission.
//
// And the role is the one for the product being asked about: requirements,
// clients, candidates and the pipeline are scoped by the ATS role, employees
// by the HRMS role, invoices by the Accounts role. An HRMS Employee who is an
// ATS Recruiter is scoped as a Recruiter in ATS and as an employee in HRMS.
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
// HRMS roles that are COMPANY-WIDE BY FUNCTION, in HRMS and only in HRMS.
// "All employees are visible to HR" (§6): the HR desk keeps the whole
// company's records, so department isolation is not the rule for it the way
// it is for a Manager, an STL or a TL. This is the HRMS twin of
// accountsGlobal() below, and it is deliberately NOT part of scopeOf().global
// — see hrmsGlobal().
const HRMS_GLOBAL_ROLES = ['HR'];
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
// 'NONE' is a product the login does not work in — never a role name to
// match against.
const named = (v) => (v && v !== 'NONE' ? v : null);

function scopeOf(user) {
  const u = user || {};
  const departments = csv(u.atsScopeDepartments).length
    ? csv(u.atsScopeDepartments)
    : (u.department ? [u.department] : []);
  const teams = csv(u.atsScopeTeams).length ? csv(u.atsScopeTeams) : (u.team ? [u.team] : []);
  // The three product roles, each falling back to the account-level role for
  // a login that predates them — the same value this file read before.
  const atsRole = named(u.atsRole) || u.role;
  const hrmsRole = named(u.hrmsRole) || u.role;
  const accountsRole = named(u.accountsRole) || u.role;
  // A login is globally scoped if it is Super Admin / Admin ANYWHERE — in its
  // account-level role or in any one of its product roles.
  const held = [u.role, named(u.hrmsRole), named(u.atsRole), named(u.accountsRole)].filter(Boolean);
  const configuredGlobal = held.some((r) => CONFIGURABLE_GLOBAL_ROLES.includes(r))
    && !csv(u.atsScopeDepartments).length;
  return {
    global: held.some((r) => GLOBAL_SCOPE_ROLES.includes(r)) || configuredGlobal,
    role: u.role,
    hrmsRole,
    accountsRole,
    atsRole,
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
  if (s.atsRole === 'CLIENT') return { id: s.clientId || '__none__' };
  if (s.atsRole === 'CANDIDATE') return { id: '__none__' };
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
  // TL / STL / Manager / Assistant Manager reach the client directory — they
  // CAN raise a requirement and this is the backing list for doing so — but
  // DEPARTMENT ISOLATION applies here too: a Medical TL is offered Medical's
  // clients, not the Educational desk's. `ownerDepartment` is the client's own
  // desk; the second arm keeps any client they already hold a requirement for,
  // so a cross-desk assignment never blanks a row they legitimately work on.
  // departmentsOf(), NOT scopeDepartments(): HR's company-wide HRMS reach is
  // an HRMS fact and must never widen the ATS client directory.
  const departments = departmentsOf(user);
  if (departments === undefined) return {};
  return {
    OR: [
      { ownerDepartment: { in: departments } },
      { requirements: { some: requirementWhere(user) } },
    ],
  };
}

// --- Applications / pipeline / interviews ----------------------------------
// One shared rule: an application is visible when its requirement is, or when
// it belongs to the signed-in candidate.
function applicationWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  if (s.atsRole === 'CANDIDATE') {
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
  if (s.atsRole === 'CANDIDATE') return { id: s.candidateId || '__none__' };
  return { applications: { some: applicationWhere(user) } };
}

// --- Invoices --------------------------------------------------------------
// An invoice is an ACCOUNTS record, so the ACCOUNTS role scopes it. A login
// whose accountsRole is None never reaches this function — can() has already
// refused the module.
function invoiceWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  if (s.accountsRole === 'CLIENT' || s.role === 'CLIENT') return { clientId: s.clientId || '__none__' };
  // An invoice's department is the department of the CLIENT it is raised
  // against, or of the REQUIREMENT it bills for. Both arms are needed: an
  // ad-hoc invoice has no requirement, and a requirement can be raised for a
  // client owned by another desk.
  // departmentsOf(), NOT scopeDepartments() — see clientWhere() above.
  const departments = departmentsOf(user);
  const byDepartment = departments === undefined ? {} : {
    OR: [
      { client: { ownerDepartment: { in: departments } } },
      { requirement: { department: { in: departments } } },
    ],
  };
  // An ACCOUNTANT with no configured department list keeps the whole ledger.
  // Configure one and they see only the invoices raised against their
  // departments' clients and requirements.
  if (s.accountsRole === 'ACCOUNTANT') return {};
  // Any other role reaching this function has the Accounts module but no
  // accounts working role (a Manager, today). Unchanged: no invoices.
  return { id: '__none__' };
}

// --- Employees -------------------------------------------------------------
// HR roles see their scope's employees; everyone else sees only themselves.
// An employee record is an HRMS record, so the HRMS role scopes it: an HRMS
// Employee sees only themselves even when their ATS role is a TL.
// SCOPE LOOKS SIDEWAYS AND DOWN, NEVER UP.
//
// A department filter alone handed a Medical TL their own STL and both
// Medical Managers — "medical TL ga login ithey, STL, Manager, vellu andharu
// endhuku kanipisthunnaru". A lead is responsible for their team, not for the
// people they report to, so an employee is in scope when their LEVEL is at or
// below the viewer's on the same ladder the leave chain climbs:
//
//   Employee -> TL -> STL -> Manager -> Asst Manager -> Admin -> Super Admin
//
// Recruiters, BDEs and Accountants sit at employee level: they are individual
// contributors, whatever product they work in.
const SENIORITY = {
  EMPLOYEE: 1, RECRUITER: 1, BDE: 1, ACCOUNTANT: 1, CANDIDATE: 1, CLIENT: 1,
  TL: 2, STL: 3, MANAGER: 4, ASSISTANT_MANAGER: 5, ADMIN: 6, SUPER_ADMIN: 7,
  // HR is not a rung on this ladder — it is company-wide in HRMS and is
  // handled by hrmsGlobal() before any of this is reached.
  HR: 6,
};
function rankOf(role) {
  return SENIORITY[role] || 1;
}

// The roles this viewer may NOT see, i.e. everyone above them.
function rolesAbove(role) {
  const mine = rankOf(role);
  return Object.keys(SENIORITY).filter((r) => SENIORITY[r] > mine);
}

// --- Employees -------------------------------------------------------------
// HR roles see their scope's employees; everyone else sees only themselves.
// An employee record is an HRMS record, so the HRMS role scopes it: an HRMS
// Employee sees only themselves even when their ATS role is a TL.
// The seniority half, applied to whatever set a role's scope selects. Kept
// separate so a TL's team filter and an STL's department filter cannot drift
// apart in how they treat the people above the viewer.
function withSeniority(s, base) {
  const above = rolesAbove(s.hrmsRole);
  return {
    ...base,
    // Their own record always survives — nobody outranks themselves — and an
    // employee with NO login stays visible, because there is no senior role on
    // a record that has no account.
    OR: [
      { id: s.employeeId || '__none__' },
      { userId: null },
      {
        user: {
          is: {
            NOT: { OR: [{ hrmsRole: { in: above } }, { role: { in: above } }] },
          },
        },
      },
    ],
  };
}

function employeeWhere(user) {
  const s = scopeOf(user);
  if (s.global) return {};
  // HR (§6) — every employee, not a department's worth.
  if (hrmsGlobal(user)) return {};
  // A TL IS SCOPED TO THEIR TEAM, NOT THEIR DEPARTMENT.
  //
  // "TL ki valla data & valla team data" — a team lead leads ONE team. The
  // department belongs to the STL above them, so a department filter handed a
  // TL a PEER TL's people as well as their own. It is invisible in the demo
  // data (one team per department today) and would surface the moment a
  // second team existed, which is exactly the kind of leak that appears in
  // production and not in testing.
  //
  // A TL with no team configured falls back to their department rather than to
  // nothing: an unassigned lead who can see nobody cannot do their job, and
  // the seniority filter below still keeps them from seeing upward.
  if (s.hrmsRole === 'TL') {
    const teams = s.teams && s.teams.length ? s.teams : null;
    const where = teams
      ? { team: { in: teams } }
      : (s.departments.length ? { department: { in: s.departments } } : null);
    if (where) return withSeniority(s, where);
  }

  if (['STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.hrmsRole) && s.departments.length) {
    return withSeniority(s, { department: { in: s.departments } });
  }
  return { id: s.employeeId || '__none__' };
}

// --- DEPARTMENT ISOLATION (all three products) ------------------------------
// "hrms ayina, ats ayina, accounts ayina, ey department vallaki ahh department
// dhey visible avvali" — whichever product, a person sees their own
// department's data and nobody else's.
//
// Four helpers, and every department-aware list in the app spreads one of
// them. This is NOT a second scoping mechanism: each one is expressed in terms
// of scopeOf() / employeeWhere() above, so widening a role's scope in one
// place widens it everywhere.

// EVERY department this user may reach, or `undefined` when they are
// unrestricted (Super Admin / Admin, or a Manager / Assistant Manager with no
// configured department list). A scoped login with no department at all gets a
// sentinel rather than [], so a `{ in: [] }` can never silently match nothing
// in one place and everything in another.
function departmentsOf(user) {
  const s = scopeOf(user);
  if (s.global) return undefined;
  return s.departments.length ? s.departments : ['__no_department_assigned__'];
}

// Is this login company-wide IN HRMS? Super Admin / Admin are, everywhere; HR
// is, here only.
//
// It is a function of the HRMS ROLE alone, and it is kept out of
// scopeOf().global on purpose: a person who is HR in HRMS and a Recruiter in
// ATS must still be a Recruiter's scope in ATS. requirementWhere(),
// clientWhere(), applicationWhere(), candidateWhere() and invoiceWhere() never
// consult it, and the two that need a department list — clientWhere() and
// invoiceWhere() — call departmentsOf() rather than scopeDepartments().
function hrmsGlobal(user) {
  const s = scopeOf(user);
  return s.global || HRMS_GLOBAL_ROLES.includes(s.hrmsRole);
}

function scopeDepartments(user) {
  if (hrmsGlobal(user)) return undefined;
  return departmentsOf(user);
}

// The Prisma `where` fragment for a model that carries its own `department`
// column (Employee, Requirement, PayrollRun, Announcement, ...).
function departmentWhere(user, field = 'department') {
  const departments = scopeDepartments(user);
  return departments === undefined ? {} : { [field]: { in: departments } };
}

// The Prisma `where` fragment for a model that hangs off an Employee —
// Attendance, LeaveRequest, Payslip, EmployeeRecord, PerformanceReview,
// HelpdeskTicket and the rest of HRMS. It is employeeWhere() lifted through
// the relation, so the three tiers stay in ONE place:
//
//   global (Super Admin / Admin / unconfigured Manager) -> every employee
//   HRMS lead with departments (STL/TL/Manager/AsstMgr) -> their departments
//   everyone else                                       -> themselves only
//
// An HRMS-only Employee therefore keeps exactly the self-service rows they had
// before, and a Medical TL stops seeing an IT employee's attendance.
function employeeRecordWhere(user, relation = 'employee') {
  const where = employeeWhere(user);
  return Object.keys(where).length ? { [relation]: where } : {};
}

// Record-level twin of employeeRecordWhere(), for the detail and decision
// endpoints. `employee` is an Employee row (anything carrying id + department).
function employeeInScope(user, employee) {
  if (!employee) return false;
  return matches(employee, employeeWhere(user));
}

// Some work is COMPANY-WIDE BY FUNCTION rather than departmental: running
// payroll and keeping the ledger are the Accounts desk's job across every
// department. "Accounts" on an accountant's record is where they SIT, not a
// recruiting desk they were scoped to, so narrowing them to it would mean an
// accountant could only invoice the Accounts department and only pay three
// people — which is not department isolation, it is a broken ledger.
//
// So an Accountant stays company-wide for Accounts and Payroll. Department
// isolation still reaches these products: it is invoiceWhere() below that
// decides, by the CLIENT's owning department and the REQUIREMENT's department,
// and a non-accountant who is granted the Accounts module is held to it.
function accountsGlobal(user) {
  const s = scopeOf(user);
  return s.global || s.accountsRole === 'ACCOUNTANT';
}

// What a screen prints when it says "you are seeing X".
// THE LINE AT THE TOP OF EVERY SCREEN (§43). It used to read the bare
// department list — "Medical", or "All departments" — which says WHERE the
// data is from but not WHY this person can see it. The blueprint asks for the
// answer in the reader's own terms: My Candidates / My Team / Medical
// Department / All Company, so there is no confusion about why a list is the
// length it is.
function scopeLabel(user) {
  const s = scopeOf(user);
  if (s.global) return 'All Company';
  if (hrmsGlobal(user)) return 'All Employees';
  const departments = scopeDepartments(user);
  if (departments === undefined) return 'All Company';

  switch (s.atsRole || s.hrmsRole) {
    case 'CLIENT': return 'My Company';
    case 'CANDIDATE': return 'My Profile';
    case 'BDE': return 'My Clients';
    case 'RECRUITER': return 'My Assigned Work';
    case 'TL': return s.teams && s.teams.length ? `My Team — ${s.teams.join(', ')}` : 'My Team';
    case 'STL':
    case 'MANAGER':
    case 'ASSISTANT_MANAGER':
      return departments.length === 1
        ? `${departments[0]} Department`
        : `${departments.length} Departments — ${departments.join(', ')}`;
    default:
      return departments.length ? departments.join(', ') : 'My Own Records';
  }
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
      if (s.atsRole === 'CANDIDATE') return record.id === s.candidateId;
      return true;
    case 'accounts':
      if (s.accountsRole === 'CLIENT' || s.role === 'CLIENT') return record.clientId === s.clientId;
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
  HRMS_GLOBAL_ROLES,
  hrmsGlobal,
  departmentsOf,
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
  scopeDepartments,
  departmentWhere,
  accountsGlobal,
  employeeRecordWhere,
  employeeInScope,
  scopeLabel,
  recordInScope,
  matches,
  OUT_OF_SCOPE,
};
