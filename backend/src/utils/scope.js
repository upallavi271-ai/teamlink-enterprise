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

const { isBdeDepartment } = require('./bdeDesk');

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
  // A CUSTOM role (utils/roleRegistry.js) is scoped as the system role it
  // borrows: identity.js puts that alias on u.scopeRoles. For a system role
  // the alias is the role itself, so nothing changes for them.
  const sr = u.scopeRoles || {};
  const atsRole = named(sr.ats) || named(u.atsRole) || u.role;
  const hrmsRole = named(sr.hrms) || named(u.hrmsRole) || u.role;
  const accountsRole = named(sr.accounts) || named(u.accountsRole) || u.role;
  // A login is globally scoped if it is Super Admin / Admin ANYWHERE — in its
  // account-level role or in any one of its product roles.
  const held = [
    u.role,
    named(sr.hrms) || named(u.hrmsRole),
    named(sr.ats) || named(u.atsRole),
    named(sr.accounts) || named(u.accountsRole),
  ].filter(Boolean);
  // Manager and Assistant Manager see EVERY department (view-only — see
  // can() in permissions.js). A department list on their login no longer
  // narrows what they see.
  const configuredGlobal = held.some((r) => CONFIGURABLE_GLOBAL_ROLES.includes(r));
  // PER-ROLE SPEC (2026-10-03): in ATS a Manager is scoped to THEIR
  // DEPARTMENTS and an Assistant Manager to their ASSIGNED TEAMS, with
  // actions. `global` keeps its HRMS meaning (Manager / Assistant Manager
  // read the whole company there, view-only); `adminGlobal` is the ATS /
  // money reading — Super Admin / Admin only. atsScopeOf() below hands every
  // ATS helper a scope whose `global` IS adminGlobal.
  const adminGlobal = held.some((r) => GLOBAL_SCOPE_ROLES.includes(r));
  return {
    global: adminGlobal || configuredGlobal,
    adminGlobal,
    role: u.role,
    hrmsRole,
    accountsRole,
    atsRole,
    userId: u.id,
    departments,
    teams,
    clientId: u.clientId || null,
    // A BDE's clients: the ones assigned to them on Users (atsScopeClients)
    // plus the ones whose Owner BDE they are (Client.bdeOwner, resolved by
    // utils/identity.js into atsOwnedClientIds — role spec 2026-09-29).
    clientIds: [...new Set([...csv(u.atsScopeClients), ...(Array.isArray(u.atsOwnedClientIds) ? u.atsOwnedClientIds : [])])],
    // A desk BDE's Client.ownerDepartment values (utils/identity.js, from
    // utils/bdeDesk.js): a Manufacturing BDE sees Manufacturing's clients.
    bdeDeskDepartments: Array.isArray(u.atsBdeDeskDepartments) ? u.atsBdeDeskDepartments : [],
    bdeDeskRequirementDepartments: Array.isArray(u.atsBdeDeskRequirementDepartments) ? u.atsBdeDeskRequirementDepartments : [],
    // ACCOUNTS (role spec 2026-09-29): the requirements that have a joined
    // candidate — resolved once per request by utils/identity.js.
    joinedRequirementIds: Array.isArray(u.atsJoinedRequirementIds) ? u.atsJoinedRequirementIds : null,
    candidateId: u.candidateId || null,
    employeeId: u.employeeId || null,
    // A TL's team members (user ids), resolved by utils/identity.js when the
    // TL has a team configured; null means "no team — department fallback".
    teamUserIds: Array.isArray(u.atsTeamUserIds) && u.atsTeamUserIds.length ? u.atsTeamUserIds : null,
    // HRMS: an STL's departments / teams (identity.js, spec item 24).
    hrmsTeamScope: Array.isArray(u.hrmsTeamScope) && u.hrmsTeamScope.length ? u.hrmsTeamScope : null,
    // THE SEAT STRUCTURE (utils/positionScope.js, resolved by identity.js):
    // set only for a TL / STL / Recruiter who holds a seat of that kind.
    // When set it is the ATS scope; null -> the team / department logic.
    positions: u.atsPositionScope && Array.isArray(u.atsPositionScope.positionCodes)
      && u.atsPositionScope.role === atsRole ? u.atsPositionScope : null,
  };
}

// The ATS reading of scopeOf(): identical, except that `global` is Super
// Admin / Admin only — a Manager / Assistant Manager is held to their
// departments / teams in ATS (per-role spec 2026-10-03). Every ATS helper in
// this file and every ATS route reads this one.
function atsScopeOf(user) {
  const s = scopeOf(user);
  return s.global === s.adminGlobal ? s : { ...s, global: s.adminGlobal };
}

// ATS departments: like departmentsOf() but a Manager / Assistant Manager is
// not unrestricted here.
function atsDepartmentsOf(user) {
  const s = atsScopeOf(user);
  if (s.global) return undefined;
  return s.departments.length ? s.departments : ['__no_department_assigned__'];
}

// --- Seat (position) scope ---------------------------------------------------
// Department -> Team -> TL seat -> recruiter seats -> current holder. Three
// pieces, used by requirementWhere() and applicationWhere() alike so the two
// can never disagree:
//   seatAssignedArms  requirements ASSIGNED to the seats' current holders
//                     (or filed under the seats' codes, for a lead)
//   work ids          what was DONE from the seats (history for a lead,
//                     the holder's own tenure for a recruiter)
//   seatPoolArm       an STL's department(s) still-unassigned openings —
//                     minus any application another team's seat worked on.
//                     NOT for a TL: "only my team's work" (user decision
//                     2026-09-25). An unassigned, unworked requirement is for
//                     the STL / Managers / HR / Admin to see and assign; a TL
//                     sees a requirement once it is assigned to their TL seat
//                     or its holder (tlId / positionCode — the assigned arms)
//                     or once one of their seats works it.
function seatAssignedArms(s) {
  const p = s.positions;
  if (p.role === 'RECRUITER') {
    return [{ recruiterId: s.userId }, { recruiterIds: { contains: s.userId } }];
  }
  const arms = [p.role === 'STL' ? { stlId: s.userId } : { tlId: s.userId }];
  if (p.role === 'STL') arms.push({ tlId: { in: p.holderUserIds } });
  arms.push({ recruiterId: { in: p.holderUserIds } });
  p.holderUserIds.forEach((id) => arms.push({ recruiterIds: { contains: id } }));
  if (p.positionCodes.length) arms.push({ positionCode: { in: p.positionCodes } });
  return arms;
}
function seatPoolArm(s) {
  const p = s.positions;
  if (p.role !== 'STL') return null;
  const departments = [...new Set([...(s.departments || []), ...(p.departments || [])])];
  return departments.length ? { department: { in: departments }, tlId: null, recruiterId: null } : null;
}
// UNASSIGNED = no TL, no primary recruiter, no co-recruiter. The same rule
// the Unassigned chip / badge / alert and POST /requirements/:id/assign's
// "unclaimed" test use.
const UNASSIGNED_WHERE = { tlId: null, recruiterId: null, OR: [{ recruiterIds: null }, { recruiterIds: '' }] };
const isUnassigned = (r) => !!r && !r.tlId && !r.recruiterId && !r.recruiterIds;

// JOBS / REQUIREMENTS ROLE SPEC (2026-09-29) §1 — "TL = assigned to my team
// + UNASSIGNED requirements in my department". This supersedes the
// 2026-09-25 "only my team's work" rule FOR THE REQUIREMENT LIST ONLY: a TL
// sees the department's unassigned openings so they can pick them up and
// assign them. Candidates / applications keep the team-only rule
// (applicationWhere never takes this arm), and so does the TL's Clients
// view ("only clients that have my team's requirements").
function tlPoolArm(s) {
  const departments = [...new Set([...(s.departments || []), ...((s.positions && s.positions.departments) || [])])];
  // Not CLOSED: the pool is work to pick up, not the department's history.
  // (`notIn`, not `not`, so matches() checks a single record exactly.)
  return departments.length
    ? { department: { in: departments }, status: { notIn: ['CLOSED'] }, AND: [UNASSIGNED_WHERE] }
    : null;
}
function seatRequirementWhere(s, { pool: withPool = true } = {}) {
  const p = s.positions;
  const pool = withPool ? (p.role === 'TL' ? tlPoolArm(s) : seatPoolArm(s)) : null;
  return {
    OR: [
      ...seatAssignedArms(s),
      ...(p.workRequirementIds.length ? [{ id: { in: p.workRequirementIds } }] : []),
      ...(pool ? [pool] : []),
    ],
  };
}
function seatApplicationWhere(s) {
  const p = s.positions;
  const pool = seatPoolArm(s);
  const arms = [{ requirement: { OR: seatAssignedArms(s) } }];
  if (p.workApplicationIds.length) arms.push({ id: { in: p.workApplicationIds } });
  if (pool) {
    arms.push(p.foreignApplicationIds.length
      ? { requirement: pool, id: { notIn: p.foreignApplicationIds } }
      : { requirement: pool });
  }
  return { OR: arms };
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
// `opts.pool === false` leaves out a TL's department-unassigned arm — the
// "my team's requirements" reading (teamRequirementWhere below).
function requirementWhere(user, opts = {}) {
  const withPool = !(opts && opts.pool === false);
  const s = atsScopeOf(user);
  if (s.global) return {};
  // HR IN ATS IS INTERNAL HIRING ONLY (access matrix 2026-09-25 §3). HR sees
  // TeamLink's own openings — requirements filed `internal` under the
  // "TeamLink Consultants — Internal Hiring" client — and none of the client
  // recruitment pipeline. The same person made an ATS Recruiter / TL on
  // Administration -> Users carries that atsRole instead and never reaches
  // this branch. applicationWhere() and candidateWhere() inherit this.
  if (s.atsRole === 'HR') return { internal: true };
  // A TL / STL / Recruiter who holds a seat is scoped by the seat structure.
  if (s.positions) return seatRequirementWhere(s, { pool: withPool });
  switch (s.atsRole) {
    case 'ACCOUNTANT':
      // Accounts (role spec 2026-09-29 §1): ONLY requirements that have a
      // joined candidate — the ones that bill. An id list (not a relation
      // filter) so matches() can check a single record exactly.
      return s.joinedRequirementIds && s.joinedRequirementIds.length
        ? { id: { in: s.joinedRequirementIds } } : { id: '__none__' };
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
      // A desk BDE (Manufacturing, Medical, Education …) sees that
      // department's requirements, as they see its clients (utils/bdeDesk.js).
      if (s.bdeDeskRequirementDepartments.length) or.push({ department: { in: s.bdeDeskRequirementDepartments } });
      return { OR: or };
    }
    case 'TL': {
      // TL = THEIR OWN TEAM'S WORK: what they lead and what their team's
      // recruiters are assigned — never another team's. PLUS (role spec
      // 2026-09-29 §1) the UNASSIGNED requirements of their department, so
      // they can be picked up and assigned (tlPoolArm; left out by
      // teamRequirementWhere). No team configured -> only what they lead.
      const arms = s.teamUserIds
        ? [
          { tlId: s.userId },
          { recruiterId: { in: s.teamUserIds } },
          ...s.teamUserIds.map((id) => ({ recruiterIds: { contains: id } })),
        ]
        : [{ tlId: s.userId }];
      const pool = withPool ? tlPoolArm(s) : null;
      if (pool) arms.push(pool);
      return arms.length === 1 ? arms[0] : { OR: arms };
    }
    case 'STL': {
      const or = [{ stlId: s.userId }];
      if (s.departments.length) or.push({ department: { in: s.departments } });
      return { OR: or };
    }
    case 'ASSISTANT_MANAGER':
      // PER-ROLE SPEC (2026-10-03): the ASSIGNED TEAMS — what their teams'
      // TLs and recruiters lead / are assigned (utils/identity.js resolves
      // the members into teamUserIds) plus the department's unassigned
      // openings, so new work can be picked up and assigned. No team
      // assigned on Users -> their department(s), as for a Manager.
      if (s.teamUserIds) {
        const arms = [
          { tlId: { in: s.teamUserIds } },
          { stlId: s.userId },
          { recruiterId: { in: s.teamUserIds } },
          ...s.teamUserIds.map((id) => ({ recruiterIds: { contains: id } })),
        ];
        const pool = withPool ? tlPoolArm(s) : null;
        if (pool) arms.push(pool);
        return { OR: arms };
      }
      return s.departments.length ? { department: { in: s.departments } } : { id: '__none__' };
    case 'MANAGER':
      // PER-ROLE SPEC (2026-10-03): their department(s), with actions.
      return s.departments.length ? { department: { in: s.departments } } : { id: '__none__' };
    default:
      // Employees / accountants with no ATS working role see no requirements.
      return { id: '__none__' };
  }
}

// "My team's requirements" — requirementWhere() without a TL's department
// pool of unassigned openings. Identical to requirementWhere() for every
// other role. Drives a TL's Clients view, their candidates / applications
// and the "My Team" chip.
function teamRequirementWhere(user) {
  return requirementWhere(user, { pool: false });
}

// Is this user personally named on this requirement's assignment chain? Used
// for the EDIT / ASSIGN split: a TL can SEE a requirement in their department
// without being the person who may re-assign or edit it.
function isAssignedTo(user, requirement) {
  const s = atsScopeOf(user);
  if (!requirement) return false;
  // A Manager / Assistant Manager runs EVERY requirement inside their own
  // department / teams (per-role spec 2026-10-03) — not only the ones that
  // name them.
  if (['MANAGER', 'ASSISTANT_MANAGER'].includes(s.atsRole) && matches(requirement, requirementWhere(user))) return true;
  const co = csv(requirement.recruiterIds);
  return requirement.recruiterId === s.userId
    || co.includes(s.userId)
    || requirement.tlId === s.userId
    || requirement.stlId === s.userId
    || requirement.bdeId === s.userId
    // A BDE owns the requirements of THEIR clients (role spec 2026-09-29:
    // "full access to own clients"), not only the ones naming them as BDE.
    || (s.atsRole === 'BDE' && !!requirement.clientId && s.clientIds.includes(requirement.clientId));
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
// THE BDE TL (user, 2026-10-08): a TL of the BDE department sees EVERY client
// and its agreement — the whole book the BDE desks between them work.
function isBdeTl(user) {
  const s = atsScopeOf(user);
  return !s.global && s.atsRole === 'TL' && isBdeDepartment(s.departments);
}

function clientWhere(user) {
  const s = atsScopeOf(user);
  if (s.global) return {};
  if (isBdeTl(user)) return {};
  // HR — Internal Hiring only: the one internal client record, nothing else.
  if (s.atsRole === 'HR') return { clientType: 'Internal' };
  // AN ATS LOGIN WITH NO ATS WORKING ROLE SEES NO ATS RECORDS.
  //
  // The ATS modules are visible to an Employee (product table), and every
  // other helper already sent a roleless login to nothing — but this one fell
  // through to the department branch, so a plain employee's Clients screen
  // showed their department's client while Requirements and Candidates showed
  // zero. One rule: the modules open, and they fill the moment that person is
  // made a Recruiter or a BDE on Administration -> Users.
  if (s.atsRole === 'EMPLOYEE') return { id: '__none__' };
  // ACCOUNTS (clients role spec 2026-09-29 §1): "clients with billing" —
  // a requirement with a joined candidate, or an invoice raised against them.
  if (s.atsRole === 'ACCOUNTANT') {
    const ids = s.joinedRequirementIds || [];
    return { OR: [...(ids.length ? [{ requirements: { some: { id: { in: ids } } } }] : []), { invoices: { some: {} } }] };
  }
  // TL (clients role spec §1): "only clients that have my team's
  // requirements" — not the department's directory, not the unassigned pool.
  if (s.atsRole === 'TL') return { requirements: { some: teamRequirementWhere(user) } };
  // STL (per-role spec 2026-10-03): VIEW only, "only where needed" — the
  // clients their section's requirements are for.
  if (s.atsRole === 'STL') return { requirements: { some: requirementWhere(user) } };
  if (s.atsRole === 'CLIENT') return { id: s.clientId || '__none__' };
  if (s.atsRole === 'CANDIDATE') return { id: '__none__' };
  // A BDE sees their own clients — assigned on Users or Owner BDE, and any
  // they hold a requirement for — plus, for a desk BDE (Manufacturing,
  // Medical, Education …), every client of that desk (utils/bdeDesk.js).
  if (s.atsRole === 'BDE') {
    return {
      OR: [
        ...(s.clientIds.length ? [{ id: { in: s.clientIds } }] : []),
        ...(s.bdeDeskDepartments.length ? [{ ownerDepartment: { in: s.bdeDeskDepartments } }] : []),
        { requirements: { some: requirementWhere(user) } },
      ],
    };
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
  // atsDepartmentsOf(): a Manager / Assistant Manager is department-held here.
  const departments = atsDepartmentsOf(user);
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
  const s = atsScopeOf(user);
  if (s.global) return {};
  // HR falls through to the requirement rule below: internal openings only.
  if (s.atsRole === 'CANDIDATE') {
    return { candidateId: s.candidateId || '__none__' };
  }
  // SEAT SCOPE IS PER APPLICATION, not per requirement: one Education opening
  // can be worked by Team A and Team B, and each TL sees their own team's
  // candidates on it, not the other's.
  if (s.positions) return seatApplicationWhere(s);
  // teamRequirementWhere: a TL's department pool of UNASSIGNED requirements
  // widens their requirement list only — never their candidates.
  return { requirement: teamRequirementWhere(user) };
}

// CLIENT NAMES FOR A PICKER (GET /requirements/client-options — the Add
// Requirement form and the Client filter). Names only, never the record. A
// TL may raise a requirement for any client of their department, so the
// picker keeps the department directory the TL's Clients view no longer has.
function clientPickerWhere(user) {
  const s = atsScopeOf(user);
  if (isBdeTl(user)) return {};
  // TL / STL / Assistant Manager may RAISE a requirement for any client of
  // their department, so the picker keeps the department directory their
  // (narrower) Clients view does not have.
  if (['TL', 'STL', 'ASSISTANT_MANAGER'].includes(s.atsRole) && !s.global) {
    const departments = atsDepartmentsOf(user);
    if (departments === undefined) return {};
    return {
      OR: [
        { ownerDepartment: { in: departments } },
        { requirements: { some: requirementWhere(user) } },
      ],
    };
  }
  return clientWhere(user);
}

// THE ROLE A SCREEN IS DRAWN FOR (Jobs / Requirements and Clients role
// specs, 2026-09-29). One answer, from the ATS scope role, shared by the
// routes that shape responses per role (routes/requirements.js,
// routes/clients.js) so the column / section / tab rules cannot drift:
//   admin      Super Admin / Admin (global)
//   mgmt       Manager / Assistant Manager (global, view-only)
//   bde · tl · stl · recruiter · accounts · hr · client · candidate · none
function atsViewRole(user) {
  const s = atsScopeOf(user);
  const held = [s.role, s.atsRole];
  if (held.some((r) => GLOBAL_SCOPE_ROLES.includes(r))) return 'admin';
  if (held.some((r) => CONFIGURABLE_GLOBAL_ROLES.includes(r))) return 'mgmt';
  if (s.global) return 'admin';
  return {
    BDE: 'bde', TL: 'tl', STL: 'stl', RECRUITER: 'recruiter', ACCOUNTANT: 'accounts',
    HR: 'hr', CLIENT: 'client', CANDIDATE: 'candidate',
  }[s.atsRole] || 'none';
}

// The role the CLIENTS screens are drawn for: atsViewRole(), except that a
// BDE TL reads clients and agreements as a BDE does (all of them — see
// clientWhere()). Requirements and candidates keep the TL view.
function clientViewRole(user) {
  return isBdeTl(user) ? 'bde' : atsViewRole(user);
}

// Record-level twin of applicationWhere() for an application already loaded
// WITH its requirement (candidate detail, etc.). Same rule, evaluated in
// memory — matches() cannot follow the `requirement` relation by itself.
function applicationInScope(user, application) {
  const s = atsScopeOf(user);
  if (s.global) return true;
  if (!application) return false;
  if (s.atsRole === 'CANDIDATE') return application.candidateId === s.candidateId;
  const r = application.requirement;
  if (!s.positions) return !!r && matches(r, teamRequirementWhere(user));
  const p = s.positions;
  if (idSet(p, 'workApplicationIds').has(application.id)) return true;
  if (!r) return false;
  if (matches(r, { OR: seatAssignedArms(s) })) return true;
  const pool = seatPoolArm(s);
  return !!pool && matches(r, pool) && !idSet(p, 'foreignApplicationIds').has(application.id);
}
// Set views of the seat scope's id lists, built once per request object —
// applicationInScope() runs once per application on a 20k-row list.
const ID_SETS = new WeakMap();
function idSet(p, key) {
  if (!ID_SETS.has(p)) ID_SETS.set(p, {});
  const cache = ID_SETS.get(p);
  if (!cache[key]) cache[key] = new Set(p[key] || []);
  return cache[key];
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
  const s = atsScopeOf(user);
  if (s.global) return {};
  // HR falls through to applicationWhere(): internal-hiring candidates only.
  if (s.atsRole === 'CANDIDATE') return { id: s.candidateId || '__none__' };
  return { applications: { some: applicationWhere(user) } };
}

// --- Invoices --------------------------------------------------------------
// An invoice is an ACCOUNTS record, so the ACCOUNTS role scopes it. A login
// whose accountsRole is None never reaches this function — can() has already
// refused the module.
function invoiceWhere(user) {
  const s = scopeOf(user);
  // Money is company-wide for Super Admin / Admin only (per-role spec
  // 2026-10-03: a Manager's "company money" is hidden). An Accountant keeps
  // the whole ledger below.
  if (s.adminGlobal) return {};
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

// A LEAD ALWAYS REACHES THEIR OWN RECORD AND THE PEOPLE WHO REPORT TO THEM.
// The team/department rule above decides the rest, but a direct report filed
// under another team — or the lead's own record, if their team is set
// differently — must not fall out of their leave, attendance and employee
// screens: "TL should see their own leave and their reportees' leave".
function withReports(s, where) {
  if (!s.employeeId) return where || { id: '__none__' };
  const mine = [{ id: s.employeeId }, { reportingManagerId: s.employeeId }];
  return { OR: where ? [...mine, where] : mine };
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
    if (where) return withReports(s, withSeniority(s, where));
  }

  // AN STL WITH PICKED TEAMS (spec item 24): each department either whole or
  // cut to the picked teams — "Education Team A + Team B" sees exactly those.
  if (s.hrmsRole === 'STL' && s.hrmsTeamScope) {
    const arms = s.hrmsTeamScope.map((d) => (d.teams && d.teams.length
      ? { department: d.department, team: { in: d.teams } }
      : { department: d.department }));
    return withReports(s, withSeniority(s, { AND: [{ OR: arms }] }));
  }
  if (['STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.hrmsRole) && s.departments.length) {
    return withReports(s, withSeniority(s, { department: { in: s.departments } }));
  }
  if (['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.hrmsRole)) return withReports(s, null);
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
//
// REVIEW #3 §27 — THE PATH, NOT JUST THE NAME: "Education → Team A → My Team",
// "Education → Team A → My Work", "All Company". Department and section come
// from the seat structure where the person holds a seat (utils/positionScope.js
// label "Education Team A"), else from their department / team fields.
//
// `product` = 'ats' asks for the ATS reading of the same login: HR is
// company-wide in HRMS ("All Employees") but Internal Hiring only in ATS, so
// the ATS header must not print the HRMS answer. No product = the old
// behaviour, which the HRMS screens rely on.
function sectionPath(s) {
  const p = s.positions;
  const pairs = [];
  if (p && p.label) {
    const depts = p.departments || [];
    p.label.split(', ').forEach((part) => {
      const d = depts.find((x) => part === x || part.startsWith(`${x} `));
      pairs.push(d ? [d, part.slice(d.length).trim()] : [part, '']);
    });
  } else if (s.departments.length) {
    const teams = s.teams || [];
    pairs.push([s.departments.join(', '), teams.join(', ')]);
  }
  const seen = new Set();
  return pairs
    .map(([d, t]) => [d, t].filter(Boolean).join(' → '))
    .filter((x) => x && !seen.has(x) && seen.add(x))
    .join(', ');
}

function scopeLabel(user, product) {
  const ats = product === 'ats';
  const s = ats ? atsScopeOf(user) : scopeOf(user);
  if (s.global) return 'All Company';
  if (ats && s.atsRole === 'HR') return 'Internal Hiring';
  if (ats && s.atsRole === 'ACCOUNTANT') return 'Billing — joined candidates';
  if (!ats && hrmsGlobal(user)) return 'All Employees';
  const departments = ats ? atsDepartmentsOf(user) : scopeDepartments(user);
  if (departments === undefined) return 'All Company';
  const path = sectionPath(s);
  const under = (tail) => (path ? `${path} → ${tail}` : tail);

  switch (s.atsRole || s.hrmsRole) {
    case 'CLIENT': return 'My Company';
    case 'CANDIDATE': return 'My Profile';
    case 'BDE': return s.departments.length ? `${s.departments.join(', ')} → My Clients` : 'My Clients';
    case 'RECRUITER': return under('My Work');
    case 'TL': return under('My Team');
    case 'ASSISTANT_MANAGER':
      if (ats && s.teamUserIds && s.teams.length) return `${s.departments.join(', ') || 'Teams'} → ${s.teams.join(', ')}`;
      // falls through — no team assigned: their department(s)
    case 'STL':
    case 'MANAGER':
      return departments.length === 1
        ? `${departments[0]} Department`
        : `${departments.length} Departments — ${departments.join(', ')}`;
    default:
      return departments.length ? departments.join(', ') : 'My Own Records';
  }
}

// --- Record-level check, used by can(..., record) and by detail endpoints ---
const ATS_SCOPE_MODULES = ['requirements', 'clients', 'candidates', 'interviews', 'recruiterbde'];
function recordInScope(user, moduleId, record) {
  const s = ATS_SCOPE_MODULES.includes(moduleId) ? atsScopeOf(user) : scopeOf(user);
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
    if (value && typeof value === 'object' && Array.isArray(value.notIn)) {
      return !value.notIn.includes(record[key]);
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
  atsDepartmentsOf,
  scopeOf,
  atsScopeOf,
  requirementWhere,
  teamRequirementWhere,
  UNASSIGNED_WHERE,
  isUnassigned,
  atsViewRole,
  clientPickerWhere,
  portalRequirementWhere,
  isAssignedTo,
  clientWhere,
  clientViewRole,
  isBdeTl,
  applicationWhere,
  applicationInScope,
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
