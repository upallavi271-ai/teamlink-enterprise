// ---------------------------------------------------------------------------
// THE permission engine.
//
// One function — can(user, product, module, feature, action, record) — used by
// route guards, by list scoping and by the nav the frontend renders. There is
// no second permission system: middleware/auth.js requireRole() is gone, and
// every former requireRole(...) site is now requirePerm(...) below.
//
// Order of checks, exactly as specified:
//   user identity -> product access -> role -> module permission
//     -> action permission -> data scope -> record ownership/assignment
//
// The module/feature/action matrix it reads is the SAME RoleAccess table that
// Administration -> Role Catalog edits. Until a role's row is saved the engine
// falls back to DEFAULT_RULES below, which reproduce, capability by capability,
// the role lists the old requireRole() guards carried. Saving a role in Role
// Catalog therefore changes real behaviour, and not saving it changes nothing.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const {
  ROLE_ACCESS_MODULES, ROLE_FEATURE_ACTIONS, moduleById,
} = require('./roleAccess');

// Which product a module belongs to. `null` = always-on core surface
// (dashboard, reports, administration) gated by role alone.
const PRODUCT_OF_MODULE = {
  dashboard: null,
  requirements: 'ats',
  clients: 'ats',
  candidates: 'ats',
  recruiterbde: 'ats',
  interviews: 'ats',
  hrms: 'hrms',
  accounts: 'accounts',
  reports: null,
  administration: null,
};

const ALL_ROLES = [
  'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL',
  'RECRUITER', 'BDE', 'CLIENT', 'ACCOUNTANT', 'EMPLOYEE', 'CANDIDATE',
];

// Named role sets. These are the OLD guard constants, moved here once so that
// the matrix defaults are provably the same permissions the routes used to
// hard-code.
const SET = {
  SUPER: ['SUPER_ADMIN'],
  ADMIN: ['SUPER_ADMIN', 'ADMIN'],
  // routes/*.js HR_ROLES
  HR: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL'],
  // routes/invoices.js + bank.js + office.js ACCOUNTS_ROLES, payroll.js PAYROLL_ROLES
  ACCOUNTS: ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT'],
  // routes/candidates.js RECRUITING_ROLES
  RECRUITING: ['SUPER_ADMIN', 'ADMIN', 'RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  // routes/applications.js PIPELINE_ROLES
  PIPELINE: ['SUPER_ADMIN', 'ADMIN', 'RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  // routes/requirements.js RAISE_ROLES
  RAISE: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'TL', 'STL', 'ASSISTANT_MANAGER'],
  // routes/requirements.js MATCHING_ROLES — never a client
  MATCHING: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'TL', 'STL', 'ASSISTANT_MANAGER', 'RECRUITER', 'BDE'],
  // --- Job Portal ---------------------------------------------------------
  // Who may OPEN the internal Job Portal workspace. Identical to MATCHING: an
  // ATS working role is what grants portal reach. An Accountant, an HRMS-only
  // Employee, a Client and a Candidate are all absent, by construction — none
  // of them holds an ATS working role, so none of them can be given the
  // workspace by accident.
  PORTAL_VIEW: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'RECRUITER', 'BDE'],
  // Who may ACT in it — publish, sync, import. "Manager | View, no publishing
  // or editing unless explicitly granted" is the access matrix's wording, and
  // Assistant Manager and STL read the same way, so the three of them get view
  // and nothing more by default. Role Catalog can widen any of them, which is
  // what "unless explicitly granted" means in an app with a real matrix.
  PORTAL_ACT: ['SUPER_ADMIN', 'ADMIN', 'TL', 'RECRUITER', 'BDE'],
  // Everyone who works inside TeamLink (no external logins).
  STAFF: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'RECRUITER', 'BDE', 'ACCOUNTANT', 'EMPLOYEE'],
  EVERYONE: ALL_ROLES,
};

// Which modules a role navigates to before anyone edits its access.
const DEFAULT_MODULES = {
  SUPER_ADMIN: ROLE_ACCESS_MODULES.map((m) => m.id),
  ADMIN: ROLE_ACCESS_MODULES.map((m) => m.id),
  MANAGER: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'accounts', 'reports'],
  ASSISTANT_MANAGER: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  STL: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  TL: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms'],
  // A recruiter reads the client directory (their requirements name a client)
  // but cannot create or edit one — see DEFAULT_RULES.
  RECRUITER: ['dashboard', 'requirements', 'clients', 'candidates', 'interviews', 'recruiterbde', 'hrms'],
  BDE: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms'],
  // A client reaches the `clients` module only to read and e-sign their OWN
  // company record — utils/scope.js pins it to their clientId.
  CLIENT: ['dashboard', 'requirements', 'clients', 'candidates', 'interviews', 'accounts'],
  // An accountant is an employee: Accounts per the catalog, HRMS self-service.
  ACCOUNTANT: ['dashboard', 'accounts', 'reports', 'hrms'],
  EMPLOYEE: ['dashboard', 'hrms'],
  // A candidate reaches their own profile, applications and interviews. Scope
  // (utils/scope.js) pins every one of those to their own candidate row.
  CANDIDATE: ['dashboard', 'candidates', 'interviews'],
};

// ---------------------------------------------------------------------------
// DEFAULT_RULES — the capability table.
//
// { module, features: '*' | [names], actions: [names], roles: [codes] }
// A role gets an action on a feature if any rule grants it. Everything else is
// denied. Super Admin and Admin are granted everything separately.
//
// Each block is annotated with the guard it replaces, so the mapping from the
// old requireRole() world to this one is auditable line by line.
// ---------------------------------------------------------------------------
const DEFAULT_RULES = [
  // --- Dashboard ---------------------------------------------------------
  { module: 'dashboard', features: '*', actions: ['view'], roles: SET.EVERYONE },
  { module: 'dashboard', features: ['Role & User Management'], actions: ['view'], roles: SET.ADMIN },

  // --- ATS: Jobs / Requirements -----------------------------------------
  // GET /requirements, GET /requirements/:id — everyone with ATS reach, scoped.
  //
  // DELIBERATELY NOT '*'. Rules are additive and a '*' expands to every
  // feature the module carries, so a wildcard here would hand a CLIENT `view`
  // on the internal Job Portal Workspace the moment that feature was added to
  // the catalog. The six requirement features are named one by one; the three
  // Job Portal features get their own rules below.
  {
    module: 'requirements',
    features: ['Requirement List', 'Create Requirement', 'Requirement Detail', 'Job Posting', 'Matching Candidates', 'Requirement Pipeline'],
    actions: ['view'],
    roles: [...SET.MATCHING, 'CLIENT'],
  },
  // requireRole(...MATCHING_ROLES) on /:id/matching-candidates
  { module: 'requirements', features: ['Matching Candidates'], actions: ['view'], roles: SET.MATCHING },
  // requireRole(...RAISE_ROLES) on POST /, PUT /:id, activate, toggle-status, generate-jd
  { module: 'requirements', features: ['Create Requirement'], actions: ['create'], roles: SET.RAISE },
  { module: 'requirements', features: ['Requirement Detail'], actions: ['edit', 'approve'], roles: SET.RAISE },
  // ASSIGN is its own action: the assignment chain (TL -> Recruiter(s) -> BDE)
  // is what drives scope, so handing it out is a lead's decision, not a
  // side-effect of being able to edit. A BDE assigns the client side of it.
  { module: 'requirements', features: ['Requirement Detail'], actions: ['assign'], roles: [...SET.RAISE, 'BDE'] },
  // A recruiter EDITS the requirements they are assigned — routes/requirements.js
  // narrows this to records they are actually named on (VIEW != EDIT).
  { module: 'requirements', features: ['Requirement Detail'], actions: ['edit'], roles: ['RECRUITER'] },
  { module: 'requirements', features: ['Requirement Detail'], actions: ['export'], roles: SET.MATCHING },
  { module: 'requirements', features: ['Job Posting'], actions: ['create', 'edit'], roles: SET.RAISE },
  { module: 'requirements', features: ['Requirement List'], actions: ['export'], roles: SET.MATCHING },
  { module: 'requirements', features: ['Requirement Pipeline'], actions: ['view'], roles: SET.MATCHING },

  // --- ATS: Jobs / Requirements -> Job Portal ---------------------------
  // THE ACCESS MATRIX, expressed once, here. Nothing in a route handler or a
  // React component re-decides any of this.
  //
  //   Super Admin / Admin   full — view, publish, sync, import
  //   Manager               view only (grantable)
  //   Assistant Manager     view only, assigned scope (grantable)
  //   STL                   view only, team/department scope (grantable)
  //   TL                    view + act, department/team scope
  //   Recruiter             view + act, own/assigned requirements
  //   BDE / BDE TL          view + act, own clients' requirements
  //   Accountant            none — no ATS working role
  //   HRMS-only Employee    none — portal access comes from an ATS role,
  //                         never from being an employee
  //   Client                Client Job Portal only, never the workspace
  //   Candidate             the public portal only; no rule here grants them
  //                         anything, and DEFAULT_MODULES.CANDIDATE does not
  //                         list `requirements` at all
  //
  // SCOPE is not in this table — utils/scope.js requirementWhere() supplies
  // it, unchanged, so a Medical recruiter's portal rows are exactly the
  // requirements they are assigned and an IT one's are exactly theirs.
  { module: 'requirements', features: ['Job Portal Workspace', 'Job Portal Applications'], actions: ['view'], roles: SET.PORTAL_VIEW },
  // `edit` publishes/unpublishes, `configure` runs Sync. Two different
  // actions because they are two different buttons: Sync and Open Job Portal
  // are not the same thing and are not granted as one.
  { module: 'requirements', features: ['Job Portal Workspace'], actions: ['edit', 'configure'], roles: SET.PORTAL_ACT },
  { module: 'requirements', features: ['Job Portal Workspace'], actions: ['export'], roles: SET.RAISE },
  // `create` on Job Portal Applications is Import to ATS.
  { module: 'requirements', features: ['Job Portal Applications'], actions: ['create'], roles: SET.PORTAL_ACT },
  // The client-facing portal view. A CLIENT holds this and NOT the two
  // features above, which is the whole of "a client never sees the internal
  // posting/sync workspace" — it is a permission, not a hidden button.
  { module: 'requirements', features: ['Client Job Portal'], actions: ['view'], roles: ['CLIENT'] },
  // `edit` is the client's DECISION on a candidate shared with them —
  // shortlist, reject, request an interview. It is a separate action from
  // `view` so a read-only client login can be issued by un-ticking one box in
  // Role Catalog, and it is deliberately NOT `candidates / Pipeline Stages /
  // edit`: that grant would hand a client the whole internal pipeline. The
  // three transitions it permits are fixed in routes/jobPortal.js and are the
  // same ones routes/applications.js STAGE_OWNERS already names a CLIENT on.
  { module: 'requirements', features: ['Client Job Portal'], actions: ['edit'], roles: ['CLIENT'] },

  // --- ATS: Clients ------------------------------------------------------
  { module: 'clients', features: '*', actions: ['view'], roles: [...SET.MATCHING, 'CLIENT'] },
  // requireRole('SUPER_ADMIN','ADMIN') on POST / and PUT /:id
  { module: 'clients', features: ['Add Client'], actions: ['create'], roles: SET.ADMIN },
  { module: 'clients', features: ['Client Detail'], actions: ['edit'], roles: SET.ADMIN },
  // requireRole(...AGREEMENT_EDIT_ROLES) — generate / send / resend / activate
  { module: 'clients', features: ['Agreement Lifecycle'], actions: ['create', 'edit'], roles: SET.ADMIN },
  // requireRole('CLIENT','SUPER_ADMIN','ADMIN') — the client confirms/e-signs
  { module: 'clients', features: ['Agreement Lifecycle'], actions: ['approve'], roles: ['SUPER_ADMIN', 'ADMIN', 'CLIENT'] },
  { module: 'clients', features: ['Commercial Terms'], actions: ['edit'], roles: SET.ADMIN },
  // ASSIGN on a client = setting its Account Manager / BDE owner. EXPORT is
  // the client directory download. Both separate from EDIT, per VIEW != EDIT.
  { module: 'clients', features: ['Client Detail'], actions: ['assign'], roles: [...SET.ADMIN, 'MANAGER', 'BDE'] },
  { module: 'clients', features: ['Client List'], actions: ['export'], roles: SET.MATCHING },

  // --- ATS: Candidates & Pipeline ---------------------------------------
  { module: 'candidates', features: '*', actions: ['view'], roles: [...SET.PIPELINE, 'CLIENT', 'CANDIDATE'] },
  // requireRole(...RECRUITING_ROLES) on POST / and PUT /:id
  { module: 'candidates', features: ['Add Candidate'], actions: ['create'], roles: SET.RECRUITING },
  { module: 'candidates', features: ['Candidate Master'], actions: ['edit'], roles: SET.RECRUITING },
  { module: 'candidates', features: ['Candidate List'], actions: ['export'], roles: SET.MATCHING },
  // requireRole(...PIPELINE_ROLES) on POST /applications, plus stage moves
  { module: 'candidates', features: ['Applications'], actions: ['create', 'edit'], roles: SET.PIPELINE },
  { module: 'candidates', features: ['Pipeline Stages'], actions: ['create', 'edit', 'approve', 'assign'], roles: SET.PIPELINE },
  { module: 'candidates', features: ['Rejection & Hold'], actions: ['edit', 'approve'], roles: SET.PIPELINE },
  { module: 'candidates', features: ['Resume & Scores'], actions: ['edit'], roles: SET.PIPELINE },

  // --- ATS: Recruiter & BDE ---------------------------------------------
  { module: 'recruiterbde', features: '*', actions: ['view'], roles: SET.MATCHING },
  { module: 'recruiterbde', features: ['Team View'], actions: ['assign'], roles: SET.RAISE },

  // --- ATS: Interviews & Joining ----------------------------------------
  // Viewing is wide (and then cut down by utils/scope.js: a client sees only
  // their own company's interviews, offers and joinings; a candidate only
  // their own). Acting is the pipeline's.
  { module: 'interviews', features: '*', actions: ['view'], roles: [...SET.MATCHING, 'CLIENT', 'CANDIDATE'] },
  { module: 'interviews', features: ['Schedule Interview'], actions: ['create', 'edit'], roles: SET.PIPELINE },
  { module: 'interviews', features: ['AI Interview'], actions: ['create', 'edit'], roles: SET.PIPELINE },
  // INTERNAL interview feedback — the panel's own record. A client never
  // writes this one; they write Client Feedback below, which is a separate
  // record on the same interview.
  { module: 'interviews', features: ['Interview Feedback'], actions: ['create', 'edit', 'approve'], roles: SET.PIPELINE },
  { module: 'interviews', features: ['Client Feedback'], actions: ['create', 'edit'], roles: [...SET.PIPELINE, 'CLIENT'] },
  // Offers and Joining are recruitment work; a client watches their own.
  { module: 'interviews', features: ['Offers', 'Joining'], actions: ['create', 'edit'], roles: SET.PIPELINE },
  { module: 'interviews', features: ['Offers', 'Joining'], actions: ['approve', 'export'], roles: SET.RAISE },
  // Internal Hiring ends in an HRMS employee record, so it is a lead's
  // action, not a recruiter's — and it never touches a client placement.
  { module: 'interviews', features: ['Internal Hiring'], actions: ['create', 'edit', 'approve'], roles: SET.RAISE },

  // --- HRMS --------------------------------------------------------------
  // Every employee reaches HRMS SELF-SERVICE: their own attendance, leave,
  // performance and service requests. Deliberately NOT a blanket '*' — payroll,
  // the HR dashboard and employee management are administration, not
  // self-service, and are granted separately below.
  {
    module: 'hrms',
    features: ['Attendance & Time', 'Leave & Holidays', 'Performance & Development', 'Employee Services'],
    actions: ['view'],
    roles: SET.STAFF,
  },
  // requireRole(...HR_ROLES) — hrmsDashboard, attendance dashboard/report/
  // biometric/punch-log/regularization decisions, leave decisions, holidays,
  // announcements, documents, assets, helpdesk, lms, performance, projects,
  // resignations, shift patterns, surveys, employee-record status decisions.
  { module: 'hrms', features: ['HRMS Dashboard'], actions: ['view', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Attendance & Time'], actions: ['create', 'edit', 'approve', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Leave & Holidays'], actions: ['create', 'edit', 'approve', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Performance & Development'], actions: ['create', 'edit', 'approve', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Employee Services'], actions: ['create', 'edit', 'approve', 'delete', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Employee Management'], actions: ['view', 'create', 'edit', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Employee Management'], actions: ['delete', 'approve', 'assign', 'configure'], roles: SET.ADMIN },
  // requireRole(...PAYROLL_ROLES) — payroll structures, runs, F&F, reports.
  { module: 'hrms', features: ['Payroll & Compensation'], actions: ['view', 'create', 'edit', 'approve', 'export'], roles: SET.ACCOUNTS },
  // requireRole('SUPER_ADMIN','ADMIN') — attendance policy, payroll policy &
  // CTC settings, leave policy (POLICY_ROLES), leave balances.
  { module: 'hrms', features: ['Attendance & Time'], actions: ['configure'], roles: SET.ADMIN },
  { module: 'hrms', features: ['Leave & Holidays'], actions: ['configure'], roles: SET.ADMIN },
  { module: 'hrms', features: ['Payroll & Compensation'], actions: ['configure'], roles: SET.ADMIN },

  // --- Accounts ----------------------------------------------------------
  // requireRole(...ACCOUNTS_ROLES) — invoices, bank (router-level), office
  // (router-level).
  { module: 'accounts', features: '*', actions: ['view'], roles: [...SET.ACCOUNTS, 'MANAGER'] },
  { module: 'accounts', features: '*', actions: ['create', 'edit', 'delete', 'approve', 'export'], roles: SET.ACCOUNTS },
  { module: 'accounts', features: ['Invoices'], actions: ['view'], roles: ['CLIENT'] },
  { module: 'accounts', features: '*', actions: ['configure'], roles: SET.ADMIN },

  // --- Reports -----------------------------------------------------------
  // A report follows the product it reports on: an accountant does not get the
  // ATS reports, and a recruiting lead does not get the accounts ledger.
  { module: 'reports', features: ['ATS Reports', 'Job Portal Reports'], actions: ['view'], roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'BDE'] },
  { module: 'reports', features: ['ATS Reports', 'Job Portal Reports'], actions: ['export'], roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'BDE', 'TL'] },
  { module: 'reports', features: ['Accounts Reports'], actions: ['view', 'export'], roles: [...SET.ACCOUNTS, 'MANAGER'] },

  // --- Administration ----------------------------------------------------
  // requireRole(...ADMIN_ROLES) throughout routes/admin.js.
  // Everything EXCEPT Departments & Teams, which stays Super-Admin-only. The
  // list is explicit rather than '*' because rules are additive: a later rule
  // can widen a grant, never narrow one.
  {
    module: 'administration',
    features: ['Company Setup', 'Users', 'Role Catalog', 'Integrations', 'Organization Structure', 'Notifications', 'Audit Logs'],
    actions: ROLE_FEATURE_ACTIONS,
    roles: SET.ADMIN,
  },
  // requireRole(...SUPER_ADMIN_ONLY) — create/delete departments and teams.
  { module: 'administration', features: ['Departments & Teams'], actions: ROLE_FEATURE_ACTIONS, roles: SET.SUPER },
  { module: 'administration', features: ['Departments & Teams'], actions: ['view'], roles: SET.ADMIN },
  // Notifications and Profile are everyone's.
  { module: 'administration', features: ['Notifications'], actions: ['view', 'edit'], roles: SET.EVERYONE },
];

// Super Admin / Admin: global. Admin still loses the SUPER-only capabilities
// above, which are listed explicitly rather than blanket-granted.
const GLOBAL_ROLES = ['SUPER_ADMIN'];

function emptyActions(value = false) {
  const out = {};
  ROLE_FEATURE_ACTIONS.forEach((a) => { out[a] = value; });
  return out;
}

// The access a role has before anything is persisted for it, computed from
// DEFAULT_RULES. This replaces the old hard-coded role lists entirely.
function defaultAccessForRole(role, moduleId) {
  const mod = moduleById(moduleId);
  const features = {};
  const names = mod ? mod.features : [];
  names.forEach((f) => { features[f] = emptyActions(false); });

  if (GLOBAL_ROLES.includes(role)) {
    names.forEach((f) => { features[f] = emptyActions(true); });
    return { moduleEnabled: true, features };
  }

  DEFAULT_RULES.forEach((rule) => {
    if (rule.module !== moduleId) return;
    if (!rule.roles.includes(role)) return;
    const targets = rule.features === '*' ? names : rule.features.filter((f) => names.includes(f));
    targets.forEach((f) => {
      rule.actions.forEach((a) => {
        if (ROLE_FEATURE_ACTIONS.includes(a)) features[f][a] = true;
      });
    });
  });

  const anyGranted = names.some((f) => ROLE_FEATURE_ACTIONS.some((a) => features[f][a]));
  const listed = (DEFAULT_MODULES[role] || []).includes(moduleId);
  return { moduleEnabled: listed && anyGranted, features };
}

// Merge a persisted RoleAccess row over the defaults, so a feature added to the
// catalog later still works for roles saved before it existed.
function mergeAccess(role, moduleId, row) {
  const base = defaultAccessForRole(role, moduleId);
  if (!row) return base;
  let saved = {};
  try { saved = row.features ? JSON.parse(row.features) : {}; } catch { saved = {}; }
  const mod = moduleById(moduleId);
  const features = {};
  (mod ? mod.features : []).forEach((f) => {
    features[f] = { ...base.features[f], ...(saved[f] || {}) };
  });
  return { moduleEnabled: !!row.moduleEnabled, features };
}

// ---------------------------------------------------------------------------
// RoleAccess cache. Invalidated whenever Role Catalog writes a row, so an
// admin's edit takes effect on the next request rather than the next restart.
// ---------------------------------------------------------------------------
const cache = new Map(); // role -> { at, modules: { moduleId: access } }
const CACHE_MS = 15000;

function invalidateRoleAccess(role) {
  if (role) cache.delete(role); else cache.clear();
}

async function accessFor(role, moduleId) {
  const now = Date.now();
  let entry = cache.get(role);
  if (!entry || now - entry.at > CACHE_MS) {
    let rows = [];
    try {
      rows = await prisma.roleAccess.findMany({ where: { role } });
    } catch {
      rows = [];
    }
    const modules = {};
    ROLE_ACCESS_MODULES.forEach((m) => {
      modules[m.id] = mergeAccess(role, m.id, rows.find((r) => r.moduleId === m.id));
    });
    entry = { at: now, modules };
    cache.set(role, entry);
  }
  return entry.modules[moduleId] || { moduleEnabled: false, features: {} };
}

// ---------------------------------------------------------------------------
// can() — the single entry point.
//
// `user` is the resolved identity (see utils/identity.js) as carried on req.user.
// `record` is optional; when given, data scope and ownership are applied too.
// ---------------------------------------------------------------------------
async function can(user, product, moduleId, feature, action, record = undefined) {
  // 1. user identity
  if (!user || !user.id) return false;
  if (user.status && user.status !== 'Active') return false;

  // 2. product access
  const owningProduct = product || PRODUCT_OF_MODULE[moduleId] || null;
  if (owningProduct && ['hrms', 'ats', 'accounts'].includes(owningProduct)) {
    const products = user.products || {};
    if (!products[owningProduct]) return false;
  }

  // 3. role
  const role = user.role;
  if (!role) return false;

  // 4. module permission + 5. action permission
  const access = await accessFor(role, moduleId);
  if (!access.moduleEnabled) return false;
  const actions = access.features[feature];
  if (!actions || !actions[action]) return false;

  // 6/7. data scope and record ownership
  if (record !== undefined && record !== null) {
    const { recordInScope } = require('./scope');
    if (!recordInScope(user, moduleId, record)) return false;
  }
  return true;
}

const DENIED = { error: "This action isn't included in your role's permissions" };

// Express guard. Replaces every requireRole(...) call site in the app.
function requirePerm(product, moduleId, feature, action) {
  return async (req, res, next) => {
    try {
      const ok = await can(req.user, product, moduleId, feature, action);
      if (!ok) return res.status(403).json(DENIED);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Product-level guard, for whole routers that belong to one product.
// A refusal message is a surface too. An external login (Client, Candidate)
// is never told the internal product name it was refused — "HRMS" is our own
// vocabulary for our own staff records and must not reach them.
const EXTERNAL_ROLES = ['CLIENT', 'CANDIDATE'];

function requireProduct(product) {
  return (req, res, next) => {
    if (!req.user || !(req.user.products || {})[product]) {
      const external = req.user && (EXTERNAL_ROLES.includes(req.user.role) || EXTERNAL_ROLES.includes(req.user.atsRole));
      return res.status(403).json({
        error: external
          ? 'This area is not part of your access'
          : `Your login does not include ${product.toUpperCase()} access`,
      });
    }
    next();
  };
}

// The whole matrix for one role — what the nav and the Role Catalog read.
async function accessMatrix(role) {
  const out = {};
  for (const m of ROLE_ACCESS_MODULES) {
    // eslint-disable-next-line no-await-in-loop
    out[m.id] = await accessFor(role, m.id);
  }
  return out;
}

module.exports = {
  PRODUCT_OF_MODULE,
  DEFAULT_MODULES,
  DEFAULT_RULES,
  SET,
  can,
  requirePerm,
  requireProduct,
  accessFor,
  accessMatrix,
  defaultAccessForRole,
  mergeAccess,
  invalidateRoleAccess,
  DENIED,
};
