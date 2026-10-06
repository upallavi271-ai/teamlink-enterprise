// ---------------------------------------------------------------------------
// THE permission engine.
//
// One function — can(user, product, module, feature, action, record) — used by
// route guards, by list scoping and by the nav the frontend renders. There is
// no second permission system: middleware/auth.js requireRole() is gone, and
// every former requireRole(...) site is now requirePerm(...) below.
//
// Order of checks, exactly as specified:
//   USER -> ACTIVE PRODUCT -> PRODUCT ROLE -> MODULE -> FEATURE -> ACTION
//        -> SCOPE -> ALLOW/DENY
//
// THREE INDEPENDENT PRODUCT ROLES. A login is not one role any more:
//
//   USER
//    ├── HRMS Role      → Employee
//    ├── ATS Role       → Recruiter
//    └── Accounts Role  → None
//
// Being an Employee in HRMS must NOT deny Recruiter actions in ATS, so the
// role this engine resolves is the role for the PRODUCT THE MODULE BELONGS TO
// (roleForProduct below), not the login's account-level `role`. A product
// role of 'NONE' (or absent) is refused outright, whatever the other two say.
//
// `role` keeps the account-level job: Super Admin / Admin, and the external
// CLIENT / CANDIDATE account kinds. It is one of the roles consulted for the
// PRODUCT-AGNOSTIC modules (dashboard, reports, administration), which resolve
// against every role the login holds — so a login that is an Employee in HRMS
// and a Recruiter in ATS reaches the ATS dashboard and the ATS reports.
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
  PRODUCT_OF_MODULE, PRODUCTS, productKeyOf, NO_ROLE,
  LEGACY_MODULES, LEGACY_INDEX, sourceOf, isLegacyModule, legacyParentOf, expandModuleIds,
} = require('./roleAccess');

// The three products a role can be held in. Everything else is core.
const ROLE_PRODUCTS = ['hrms', 'ats', 'accounts'];

// ---------------------------------------------------------------------------
// STEP 3 OF THE ENGINE — THE PRODUCT ROLE.
//
// roleForProduct(user, 'ats') is the ONLY place the app decides which role
// answers for a product. The stored per-user column wins; a login that
// predates the three columns falls back to its account-level `role` for any
// product it actually holds, which is exactly what the engine used before,
// so nothing loses access on day one.
// ---------------------------------------------------------------------------
// 'NONE' is not a role to look up — it is a REFUSAL, stored. It is different
// from null, which means "nobody has decided yet" and falls back.
function roleForProduct(user, product) {
  if (!user || !ROLE_PRODUCTS.includes(product)) return null;
  const products = user.products || {};
  if (!products[product]) return null;
  const stored = product === 'hrms' ? user.hrmsRole
    : product === 'ats' ? user.atsRole
      : user.accountsRole;
  // accountsRole = None refuses Accounts OUTRIGHT, whatever the HRMS or ATS
  // role is and whatever the product boolean says. An unset column (null)
  // is not a refusal: it falls back to the account-level role, which is what
  // the engine resolved against before the three columns existed.
  if (stored === NO_ROLE) return null;
  return stored || user.role || null;
}

// The three product roles at a glance — what the Users screen renders and
// what the identity carries.
function productRolesOf(user) {
  return {
    hrms: roleForProduct(user, 'hrms') || NO_ROLE,
    ats: roleForProduct(user, 'ats') || NO_ROLE,
    accounts: roleForProduct(user, 'accounts') || NO_ROLE,
  };
}

// Which role(s) answer for a module.
//   * a product module  → exactly one role, the product's
//   * a core module     → every role the login holds, account-level `role`
//                         included, because Dashboard / Reports /
//                         Administration are not any one product's
const NO_SUCH_ROLE = '__no_role__';

function rolesFor(user, product) {
  if (ROLE_PRODUCTS.includes(product)) {
    const role = roleForProduct(user, product);
    return role ? [role] : [];
  }
  const set = new Set();
  if (user.role) set.add(user.role);
  ROLE_PRODUCTS.forEach((p) => {
    const r = roleForProduct(user, p);
    if (r) set.add(r);
  });
  return [...set];
}

const ALL_ROLES = [
  'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR',
  'RECRUITER', 'BDE', 'CLIENT', 'ACCOUNTANT', 'EMPLOYEE', 'CANDIDATE',
];

// Named role sets. These are the OLD guard constants, moved here once so that
// the matrix defaults are provably the same permissions the routes used to
// hard-code.
const SET = {
  SUPER: ['SUPER_ADMIN'],
  ADMIN: ['SUPER_ADMIN', 'ADMIN'],
  // routes/*.js HR_ROLES — everyone who administers OTHER PEOPLE'S HRMS
  // records rather than only their own. 'HR' (§6) is the one role in this set
  // that is HRMS-ONLY: it holds no ATS or Accounts role at all, and it is the
  // one member that is NOT department-scoped (utils/scope.js hrmsGlobal).
  HR: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR'],
  // THE HR DESK. SET.HR above is "everyone who administers other people's
  // HRMS records" and it deliberately includes a Manager, an Assistant
  // Manager, an STL and a TL — all of whom read employee records. This
  // narrower set is the people whose JOB is the employee master: creating the
  // record, issuing the credentials and deciding the profile submissions.
  // Manager and Assistant Manager are NOT in it (§3/§4 make them view-only)
  // and neither are STL/TL, who look after their own team but do not run
  // onboarding.
  HR_DESK: ['SUPER_ADMIN', 'ADMIN', 'HR'],
  // HR READS ATS, it does not work it. The product table gives HR
  // "HRMS + ATS + Job Portal"; what that means in practice is oversight —
  // seeing which openings are live and who is in the pipeline — not raising
  // requirements or moving candidates. The write rules keep their own sets.
  HR_ATS_VIEW: ['HR'],
  // AN EMPLOYEE'S ATS IS THE JOB PORTAL. That is the one thing an employee
  // who is not a recruiter actually has business with: browsing openings and
  // referring people. Give them the pipeline as well and they would see the
  // company's candidates, which no product table asks for.
  EMPLOYEE_PORTAL: ['EMPLOYEE'],
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
  // WHO SEES CLIENTS. The client list, client details, agreements and
  // commercial terms are the BDE team's and management's — Super Admin,
  // Admin, Manager, Assistant Manager, BDE — and nobody else's. TLs,
  // recruiters, HR and employees work requirements and candidates; raising a
  // requirement picks its client from a names-only list
  // (GET /requirements/client-options), never the client record.
  // UPDATED by the clients role spec (2026-09-29): this is still the FULL
  // client desk; a TL now gets a limited read-only view and Accounts a
  // billing view (DEFAULT_RULES clients block). A Recruiter still gets none.
  CLIENT_DESK: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'BDE'],
  // --- Job Portal ---------------------------------------------------------
  // Who may OPEN the internal Job Portal workspace. Identical to MATCHING: an
  // ATS working role is what grants portal reach. An Accountant, an HRMS-only
  // Employee, a Client and a Candidate are all absent, by construction — none
  // of them holds an ATS working role, so none of them can be given the
  // workspace by accident.
  // Job Portal reach follows the PRODUCT TABLE: everybody permitted ATS is
  // permitted the portal inside it. HR and EMPLOYEE are here now because
  // the table says HRMS + ATS + Job Portal for both. ACCOUNTANT is not:
  // Accounts only.
  PORTAL_VIEW: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR', 'RECRUITER', 'BDE', 'EMPLOYEE'],
  // Who may ACT in it — publish, sync, import. "Manager | View, no publishing
  // or editing unless explicitly granted" is the access matrix's wording, and
  // Assistant Manager and STL read the same way, so the three of them get view
  // and nothing more by default. Role Catalog can widen any of them, which is
  // what "unless explicitly granted" means in an app with a real matrix.
  // JOBS / REQUIREMENTS ROLE SPEC (2026-09-29) §2: Job Portal is ✅ for Admin,
  // BDE and TL, 👁 for Management and 👁 (own jobs) for a Recruiter — so a
  // Recruiter no longer publishes or syncs. A Recruiter still does Recruiter
  // Review → Send to ATS on the applications (PORTAL_INTAKE below).
  PORTAL_ACT: ['SUPER_ADMIN', 'ADMIN', 'TL', 'BDE'],
  PORTAL_INTAKE: ['SUPER_ADMIN', 'ADMIN', 'TL', 'RECRUITER', 'BDE'],
  // §3 Export: Admin ✅ · Mgmt ✅ · BDE own · TL team · Accounts ✅ ·
  // Recruiter ❌. (STL keeps the export it had.)
  REQ_EXPORT: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'BDE', 'ACCOUNTANT'],
  // Everyone who works inside TeamLink (no external logins).
  STAFF: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR', 'RECRUITER', 'BDE', 'ACCOUNTANT', 'EMPLOYEE'],
  EVERYONE: ALL_ROLES,
};

// Which modules a role navigates to before anyone edits its access.
const DEFAULT_MODULES = {
  SUPER_ADMIN: ROLE_ACCESS_MODULES.map((m) => m.id),
  ADMIN: ROLE_ACCESS_MODULES.map((m) => m.id),
  // NO `accounts` (access matrix 2026-09-25 §4): Accounts is NOT automatic
  // for a Manager. Grant it per login (Users -> Accounts role Accountant) or
  // per role (Role Catalog -> Manager -> Accounts, which then picks up the
  // view-only rule for MANAGER in DEFAULT_RULES below).
  MANAGER: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  ASSISTANT_MANAGER: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  // + `clients` (per-role spec 2026-10-03): an STL reads, view only, the
  // clients their section's requirements are for — names / basics.
  STL: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  // `reports` is in both of these because DEFAULT_RULES below already grants a
  // TL and a BDE the ATS and Job Portal reports (view, and export for a TL) —
  // the module list was the only thing withholding them, which made the grant
  // unreachable and, until routes/reports.js was guarded, made the endpoint
  // answer anyway. Listing it here is what those two rules always meant.
  // `clients` (clients role spec 2026-09-29 §2): a TL gets a LIMITED,
  // read-only Clients view — only the clients their team's requirements are
  // for, contact NAMES only, no commercial terms (DEFAULT_RULES below +
  // utils/scope.js clientWhere + utils/clientRedact.js).
  TL: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  // HR (§6) — HRMS AND NOTHING ELSE.
  //
  // Dashboard, HRMS, HRMS Reports, Notifications and Profile. There is no
  // `requirements` / `clients` / `candidates` / `recruiterbde` / `interviews`
  // and no `accounts` in this list, so ATS internal recruitment data, the
  // recruiter pipeline, the BDE workflow, client recruitment data, invoices,
  // bank reconciliation and finance are all refused — by the matrix, before
  // any product boolean is even consulted. `administration` is absent for the
  // same reason it is absent for MANAGER: Notifications and Profile are
  // everyone's and carry no permission (frontend/src/nav.js ADMIN_ITEMS),
  // while the Administration screens proper are Super Admin / Admin.
  //
  // HR is a PRODUCT ROLE IN HRMS, never a special case outside the per-product
  // model: the same person may be HR in HRMS and a Recruiter in ATS, and the
  // engine resolves each module against its own product's role as usual.
  // HR — HRMS + ATS + Job Portal per the product table. What HR can DO in
  // ATS is still the matrix's business; this only says the modules are
  // reachable.
  // The user's rule: HR in ATS = Internal Hiring only. requirements /
  // candidates / interviews stay reachable because utils/scope.js pins HR to
  // the INTERNAL openings and their candidates; Recruiter & BDE is not HR's.
  HR: ['dashboard', 'hrms', 'requirements', 'candidates', 'interviews', 'reports'],
  // A recruiter reads the client directory (their requirements name a client)
  // but cannot create or edit one — see DEFAULT_RULES.
  // `reports` — a recruiter's OWN ATS reports (§8 / §14). The data is cut to
  // their assigned requirements by utils/scope.js, never company-wide.
  RECRUITER: ['dashboard', 'requirements', 'candidates', 'interviews', 'recruiterbde', 'hrms', 'reports'],
  BDE: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  // A client reaches the `clients` module only to read and e-sign their OWN
  // company record — utils/scope.js pins it to their clientId.
  // + `reports` (per-role spec 2026-10-03): Client Reports — their own
  // company's numbers on the portal, and nothing else in Reports.
  CLIENT: ['dashboard', 'requirements', 'clients', 'candidates', 'interviews', 'accounts', 'reports'],
  // An accountant is an employee: Accounts per the catalog, HRMS self-service.
  // ACCOUNTANT — Accounts is the job, and HRMS SELF-SERVICE comes with being
  // an employee. Taking `hrms` off this list made the screens unreachable
  // even though every rule still allowed them: SET.STAFF already grants the
  // four self-service features and SET.ACCOUNTS already grants payroll, so
  // the endpoints answered 200 while the sidebar had no way in. An
  // accountant applies for their own leave like anybody else.
  // + `requirements` / `clients` (role specs 2026-09-29): an Accounts login
  // that is given ATS (Users -> ATS role "Accountant") reads, read-only, the
  // requirements that have JOINED candidates and the clients it bills — the
  // billing view. No Job Portal, no candidates, no pipeline actions.
  ACCOUNTANT: ['dashboard', 'accounts', 'reports', 'hrms', 'requirements', 'clients'],
  // EMPLOYEE — HRMS + ATS + Job Portal per the product table. With no ATS
  // ROLE they reach the modules and see nothing in them, because
  // utils/scope.js gives an ATS-roleless login no requirements, no
  // candidates and no clients. Being made a Recruiter on Users is what
  // fills them, on the SAME login.
  EMPLOYEE: ['dashboard', 'hrms', 'requirements', 'candidates', 'recruiterbde', 'interviews', 'reports'],
  // A candidate reaches their own profile, applications and interviews. Scope
  // (utils/scope.js) pins every one of those to their own candidate row.
  CANDIDATE: ['dashboard', 'candidates', 'interviews'],
};
// HRMS / ACCOUNTS ARE MODULE BY MODULE NOW (utils/roleAccess.js
// SPLIT_MODULES). The lists above keep the old area names because that is
// what they were decided as; 'hrms' here means every HRMS module and
// 'accounts' every Accounts module — exactly the reach the one old module gave.
Object.keys(DEFAULT_MODULES).forEach((r) => { DEFAULT_MODULES[r] = expandModuleIds(DEFAULT_MODULES[r]); });
// AI ASSISTANT & AGENT is every internal role's (the user, 2026-09-29: "all
// employees can use the AI agent and assistant, but features/actions per
// their role permissions"). Outside logins (Client, Candidate) never get it.
// Super Admin / Admin already list every module.
SET.STAFF.forEach((r) => {
  if (DEFAULT_MODULES[r] && !DEFAULT_MODULES[r].includes('ai')) DEFAULT_MODULES[r].push('ai');
});
// Which products a role reaches by default — for the AI "Answers from …"
// grants, which follow the products a role already has and never add one.
const PRODUCT_MODULE_IDS = { hrms: [], ats: [], accounts: [] };
Object.entries(PRODUCT_OF_MODULE).forEach(([m, p]) => { if (PRODUCT_MODULE_IDS[p] && !isLegacyModule(m)) PRODUCT_MODULE_IDS[p].push(m); });
const rolesReaching = (product) => SET.STAFF.filter((r) => (DEFAULT_MODULES[r] || []).some((m) => PRODUCT_MODULE_IDS[product].includes(m)));

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
  // Not '*': 'System Alerts' (Job Portal connection / sync failures, AI
  // credits) is Super Admin's by default (per-role spec 2026-10-03 — Admin
  // only when granted in Role Catalog).
  { module: 'dashboard', features: ['KPI Overview', 'Department Strength', 'Pending Approvals', 'Alerts & Notifications', 'Upcoming Interviews', 'Quick Actions', 'Recruiter Leaderboard', 'Role & User Management'], actions: ['view'], roles: SET.EVERYONE },
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
    // NOT 'CLIENT' (review #3 access audit): a client's surface is the portal
    // (routes/portal.js, /job-portal/client — the 'Client Job Portal' feature
    // below), never the internal requirement list / detail / matching, which
    // carry every application and staff names.
    roles: [...SET.MATCHING, ...SET.HR_ATS_VIEW],
  },
  // requireRole(...MATCHING_ROLES) on /:id/matching-candidates
  { module: 'requirements', features: ['Matching Candidates'], actions: ['view'], roles: SET.MATCHING },
  // ---- JOBS / REQUIREMENTS ROLE SPEC (2026-09-29) ------------------------
  //   §3 Add Requirement  Admin ✅ · BDE ✅ · TL ⚠️ optional (kept, as it was)
  //                       · Mgmt ❌ (view-only pass) · Recruiter ❌ · Accounts ❌
  //   §7 Assign TL / Recruiter  TL ✅ · BDE ✅ · Admin ✅
  //   §7 Close / Reopen / Delete  BDE ✅ close only (routes/requirements.js
  //      narrows `approve` for a BDE to Close) · Admin ✅ · TL ❌ · Recruiter ❌
  //   §6 Recruiter = View Candidates / Add Candidate — no requirement edits.
  //   §1 Accounts = read-only, requirements with joined candidates only.
  { module: 'requirements', features: ['Requirement List', 'Requirement Detail', 'Requirement Pipeline'], actions: ['view'], roles: ['ACCOUNTANT'] },
  // PER-ROLE SPEC (2026-10-03) — newest wins:
  //   Create a job   Super Admin · Admin · Manager (dept) · Asst Manager
  //                  (teams) · STL (section) · TL (team) · Internal HR
  //                  (INTERNAL jobs only — routes/requirements.js forces it)
  //                  · NOT a Recruiter · NOT a BDE (a BDE REQUESTS one:
  //                  'Requirement Request' below)
  //   Activate / hold / close   Manager all three · Asst Manager and STL HOLD
  //                  only (routes/requirements.js narrows) · BDE close only
  //                  (kept from the 2026-09-29 spec) · TL none
  { module: 'requirements', features: ['Create Requirement'], actions: ['create'], roles: [...SET.RAISE, 'HR'] },
  { module: 'requirements', features: ['Requirement Detail'], actions: ['edit'], roles: [...SET.RAISE, 'BDE'] },
  { module: 'requirements', features: ['Requirement Detail'], actions: ['approve'], roles: [...SET.RAISE.filter((r) => r !== 'TL'), 'BDE'] },
  // 'Requirement Request' — ask for a new job (saved as a DRAFT a lead
  // activates). A BDE for their own clients; a CLIENT from the portal.
  { module: 'requirements', features: ['Requirement Request'], actions: ['view', 'create'], roles: ['BDE', 'CLIENT'] },
  // …and the leads who activate (approve) a request.
  { module: 'requirements', features: ['Requirement Request'], actions: ['view', 'approve'], roles: [...SET.ADMIN, 'MANAGER'] },
  // ASSIGN is its own action: the assignment chain (TL -> Recruiter(s) -> BDE)
  // is what drives scope, so handing it out is a lead's decision, not a
  // side-effect of being able to edit. A BDE assigns the client side of it.
  { module: 'requirements', features: ['Requirement Detail'], actions: ['assign'], roles: [...SET.RAISE, 'BDE'] },
  // PERMANENT DELETE (per-role spec 2026-10-03): Super Admin only — an Admin
  // closes instead. routes/requirements.js still refuses it (409) while the
  // requirement carries any candidate or invoice.
  { module: 'requirements', features: ['Requirement Detail'], actions: ['delete'], roles: SET.SUPER },
  // EXPORT (2026-10-03 import / export rule): everyone exports the jobs in
  // their own scope — a Recruiter their own, HR the internal ones.
  { module: 'requirements', features: ['Requirement Detail'], actions: ['export'], roles: [...SET.REQ_EXPORT, 'RECRUITER', 'HR'] },
  // A Recruiter UPDATES THE JOB POSTING of their own jobs (spec §7) — edit,
  // never create a job.
  { module: 'requirements', features: ['Job Posting'], actions: ['create', 'edit'], roles: [...SET.RAISE, 'BDE'] },
  { module: 'requirements', features: ['Job Posting'], actions: ['edit'], roles: ['RECRUITER'] },
  { module: 'requirements', features: ['Requirement List'], actions: ['export'], roles: [...SET.REQ_EXPORT, 'RECRUITER', 'HR'] },
  { module: 'requirements', features: ['Requirement Pipeline'], actions: ['view'], roles: SET.MATCHING },
  // IMPORT (2026-10-03): view = may upload a sheet, create = rows become
  // jobs directly. Super Admin / Admin, Manager (their departments) and HR
  // (internal jobs only) import directly; a BDE imports REQUESTS (view
  // without create — ioAccessFor() importMode 'request').
  { module: 'requirements', features: ['Bulk Import'], actions: ['view', 'create'], roles: [...SET.ADMIN, 'MANAGER', 'HR'] },
  { module: 'requirements', features: ['Bulk Import'], actions: ['view'], roles: ['BDE'] },

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
  // `create` on Job Portal Applications is Import / Send to ATS — the
  // recruiter's own step in the intake flow, so it keeps PORTAL_INTAKE.
  { module: 'requirements', features: ['Job Portal Applications'], actions: ['create'], roles: SET.PORTAL_INTAKE },
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
  // A CLIENT no longer reads the internal client record (commercial terms,
  // fees, owners): its own company is on the portal and its agreement on
  // /agreement/:clientId (routes/agreementSeal.js), which decide for themselves.
  // ---- CLIENTS ROLE SPEC (2026-09-29) -------------------------------------
  //   §2 menu   Admin, Mgmt, BDE ✅ · TL 👁 limited · Accounts 👁 billing ·
  //             Recruiter ❌ (no Client List view at all -> /clients 403)
  //   §3        Add Client Admin + BDE · Import Admin (BDE optional: off) ·
  //             Export Admin, Mgmt, BDE own, Accounts · Merge Duplicates Admin
  //   §5 / §6   Agreements + fee / guarantee / payment terms: Admin, Mgmt,
  //             BDE (own), Accounts — never a TL or a Recruiter
  // What each of those roles may SEE of a record (contact names only for a
  // TL, the billing contact for Accounts, invoice status only for a BDE) is
  // utils/clientRedact.js; WHICH clients is utils/scope.js clientWhere().
  // PER-ROLE SPEC (2026-10-03): the full read stays with Super Admin, Admin,
  // Manager (their departments) and BDE (own clients). An Assistant Manager
  // is VIEW only — name, owner, open jobs, agreement STATUS (no revenue, no
  // commercial terms); an STL and a TL read names / basics only
  // (utils/clientRedact.js), a Recruiter nothing (the user, 2026-10-03:
  // "only the client name and the requirement").
  { module: 'clients', features: '*', actions: ['view'], roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'BDE'] },
  // (the agreement STATUS is on every client row; the agreement itself is not)
  { module: 'clients', features: ['Client List', 'Client Detail', 'Client Requirements'], actions: ['view'], roles: ['ASSISTANT_MANAGER'] },
  // Spec 6 (2026-10-03): the agreement is VIEWED by the BDE (own), Accounts,
  // Admin, Super Admin, the Manager AND the Assistant Manager.
  { module: 'clients', features: ['Agreement Lifecycle', 'Commercial Terms'], actions: ['view'], roles: ['ASSISTANT_MANAGER'] },
  { module: 'clients', features: ['Client List', 'Client Detail', 'Client Requirements'], actions: ['view'], roles: ['TL', 'STL'] },
  { module: 'clients', features: ['Client List', 'Client Detail', 'Client Requirements', 'Agreement Lifecycle', 'Commercial Terms'], actions: ['view'], roles: ['ACCOUNTANT'] },
  // A BDE has FULL access to their OWN clients (scope keeps it to them).
  { module: 'clients', features: ['Add Client'], actions: ['create'], roles: [...SET.ADMIN, 'BDE'] },
  { module: 'clients', features: ['Client Detail'], actions: ['edit'], roles: [...SET.ADMIN, 'BDE'] },
  // Client delete — PERMANENT, so Super Admin only (per-role spec
  // 2026-10-03); routes/clients.js refuses it (409) while the client has
  // active requirements. 'Delete Client' is the same decision, named.
  { module: 'clients', features: ['Client Detail'], actions: ['delete'], roles: SET.SUPER },
  { module: 'clients', features: ['Delete Client'], actions: ['delete'], roles: SET.SUPER },
  // CLIENT LIFECYCLE (2026-10-03). Pause / Reactivate: edit = do it
  // directly (Super Admin, Admin, a Manager on THEIR departments' clients —
  // utils/scope.js clientWhere), create = only REQUEST a pause (the owner
  // BDE; an Admin / Manager approves). Archive: Super Admin / Admin.
  { module: 'clients', features: ['Pause / Reactivate Client'], actions: ['edit'], roles: [...SET.ADMIN, 'MANAGER'] },
  { module: 'clients', features: ['Pause / Reactivate Client'], actions: ['create'], roles: ['BDE'] },
  { module: 'clients', features: ['Archive Client'], actions: ['edit'], roles: SET.ADMIN },
  // Notes on a client (Activity): Admin, Manager (their departments), the
  // owner BDE, Accounts.
  { module: 'clients', features: ['Client Notes'], actions: ['view', 'create'], roles: [...SET.ADMIN, 'MANAGER', 'BDE', 'ACCOUNTANT'] },
  // generate / send / resend / activate — Super Admin / Admin
  // Spec 6 (2026-10-03): the agreement and its terms are EDITED by Super
  // Admin and Admin only — a BDE views their own clients' agreements.
  { module: 'clients', features: ['Agreement Lifecycle'], actions: ['create', 'edit'], roles: SET.ADMIN },
  // requireRole('CLIENT','SUPER_ADMIN','ADMIN') — the client confirms/e-signs
  { module: 'clients', features: ['Agreement Lifecycle'], actions: ['approve'], roles: ['SUPER_ADMIN', 'ADMIN', 'CLIENT'] },
  { module: 'clients', features: ['Commercial Terms'], actions: ['edit'], roles: SET.ADMIN },
  // ASSIGN on a client = its portal invite / account manager (a BDE invites
  // their own client). Re-assigning the OWNER BDE itself is Admin only
  // (routes/clients.js PUT refuses a bdeOwner change from anyone not global).
  { module: 'clients', features: ['Client Detail'], actions: ['assign'], roles: [...SET.ADMIN, 'MANAGER', 'BDE'] },
  // CLIENT PORTAL LOGINS (spec B1, 2026-10-03): the owner BDE REQUESTS a
  // client login (create) or its disabling; Super Admin / Admin — and a
  // Manager for their departments' clients — approve + create / disable
  // (approve). TL, Recruiter, HR: nothing. routes/portalLogins.js.
  { module: 'clients', features: ['Client Portal Logins'], actions: ['view'], roles: [...SET.ADMIN, 'MANAGER', 'BDE'] },
  { module: 'clients', features: ['Client Portal Logins'], actions: ['create'], roles: [...SET.ADMIN, 'BDE'] },
  { module: 'clients', features: ['Client Portal Logins'], actions: ['approve'], roles: [...SET.ADMIN, 'MANAGER'] },
  // CANDIDATE PORTAL (spec B2): "Invite to portal" — the owner Recruiter, the
  // TL and Admin (never a Client or a BDE); approve = the Admin queue
  // (privacy / delete-my-data requests, archiving idle logins).
  { module: 'candidates', features: ['Candidate Portal Invite'], actions: ['create'], roles: [...SET.ADMIN, 'TL', 'RECRUITER'] },
  { module: 'candidates', features: ['Candidate Portal Invite'], actions: ['view', 'approve'], roles: SET.ADMIN },
  // Export: Admin, Manager (department), BDE (own clients), Accounts — not
  // an Assistant Manager (the export carries revenue / terms).
  { module: 'clients', features: ['Client List'], actions: ['export'], roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'BDE', 'ACCOUNTANT'] },
  // Import clients / agreement updates: Admin and a Manager (their
  // departments) directly; a BDE imports REQUESTS (view without create).
  // Merge Duplicates stays Admin-only (routes/clientMerge.js).
  { module: 'clients', features: ['Bulk Import'], actions: ['view', 'create'], roles: [...SET.ADMIN, 'MANAGER'] },
  { module: 'clients', features: ['Bulk Import'], actions: ['view'], roles: ['BDE'] },

  // --- ATS: Candidates & Pipeline ---------------------------------------
  // No CLIENT / CANDIDATE: outside logins use /api/portal (review #3 access audit).
  // A BDE reads the people submitted to their clients — never the internal
  // scores (per-role spec 2026-10-03), so not 'Resume & Scores'.
  { module: 'candidates', features: ['Candidate List', 'Add Candidate', 'Candidate Master', 'Applications', 'Pipeline Stages', 'Rejection & Hold', 'Resume & Scores'], actions: ['view'], roles: SET.PIPELINE.filter((r) => r !== 'BDE') },
  { module: 'candidates', features: ['Candidate List', 'Add Candidate', 'Candidate Master', 'Applications', 'Pipeline Stages', 'Rejection & Hold'], actions: ['view'], roles: ['BDE'] },
  // CANDIDATE IMPORT (2026-10-03): Admin, Manager (dept), TL (team),
  // Recruiter (own), HR (internal) — each into their own scope.
  { module: 'candidates', features: ['Bulk Import'], actions: ['view', 'create'], roles: [...SET.ADMIN, 'MANAGER', 'TL', 'RECRUITER', 'HR'] },
  // requireRole(...RECRUITING_ROLES) on POST / and PUT /:id
  { module: 'candidates', features: ['Add Candidate'], actions: ['create'], roles: SET.RECRUITING },
  { module: 'candidates', features: ['Candidate Master'], actions: ['edit'], roles: SET.RECRUITING },
  { module: 'candidates', features: ['Candidate List'], actions: ['export'], roles: SET.MATCHING },
  // requireRole(...PIPELINE_ROLES) on POST /applications, plus stage moves
  { module: 'candidates', features: ['Applications'], actions: ['create', 'edit'], roles: SET.PIPELINE },
  { module: 'candidates', features: ['Pipeline Stages'], actions: ['create', 'edit', 'approve', 'assign'], roles: SET.PIPELINE },
  { module: 'candidates', features: ['Rejection & Hold'], actions: ['edit', 'approve'], roles: SET.PIPELINE },
  { module: 'candidates', features: ['Resume & Scores'], actions: ['edit'], roles: SET.PIPELINE.filter((r) => r !== 'BDE') },

  // --- ATS: Recruiter & BDE ---------------------------------------------
  { module: 'recruiterbde', features: '*', actions: ['view'], roles: SET.MATCHING },
  { module: 'recruiterbde', features: ['Team View'], actions: ['assign'], roles: SET.RAISE },

  // --- ATS: Interviews & Joining ----------------------------------------
  // Viewing is wide (and then cut down by utils/scope.js: a client sees only
  // their own company's interviews, offers and joinings; a candidate only
  // their own). Acting is the pipeline's.
  // No CLIENT / CANDIDATE: the calendar carries AI results and internal panel
  // feedback. A client decides on the portal; its Client Feedback grant stays.
  { module: 'interviews', features: '*', actions: ['view'], roles: SET.MATCHING },
  { module: 'interviews', features: ['Schedule Interview'], actions: ['create', 'edit'], roles: SET.PIPELINE },
  // A BDE confirms CLIENT interviews and records the client's feedback
  // (per-role spec 2026-10-03) — not the AI interview, not the internal panel.
  { module: 'interviews', features: ['AI Interview'], actions: ['create', 'edit'], roles: SET.PIPELINE.filter((r) => r !== 'BDE') },
  // INTERNAL interview feedback — the panel's own record. A client never
  // writes this one; they write Client Feedback below, which is a separate
  // record on the same interview.
  { module: 'interviews', features: ['Interview Feedback'], actions: ['create', 'edit', 'approve'], roles: SET.PIPELINE.filter((r) => r !== 'BDE') },
  { module: 'interviews', features: ['Client Feedback'], actions: ['create', 'edit'], roles: [...SET.PIPELINE, 'CLIENT'] },
  // Offers and Joining are recruitment work; a client watches their own.
  { module: 'interviews', features: ['Offers', 'Joining'], actions: ['create', 'edit'], roles: SET.PIPELINE },
  { module: 'interviews', features: ['Offers', 'Joining'], actions: ['approve', 'export'], roles: SET.RAISE },
  // Internal Hiring ends in an HRMS employee record, so it is a lead's
  // action, not a recruiter's — and it never touches a client placement.
  // HR runs internal hiring (the user's rule: HR's ATS is Internal Hiring).
  { module: 'interviews', features: ['Internal Hiring'], actions: ['create', 'edit', 'approve'], roles: [...SET.RAISE, ...SET.HR_ATS_VIEW] },

  // --- ATS: EXPORT ON EVERY MODULE (hrms-25, routes/atsIo.js) -------------
  // "ATS lo prathi module lo export & import buttons vundali." Export is a
  // READ of the screen's own scoped rows, so it goes to the ATS working roles
  // that already VIEW these screens — a recruiter's file is their own work, a
  // TL's their team's (utils/scope.js). The features that already carried an
  // export grant keep it; these are the ones that had none. Client-module
  // data stays with the client desk (Client List / export above).
  { module: 'recruiterbde', features: ['Team View', 'Recruiter Workload', 'BDE Workload', 'Pending Actions'], actions: ['export'], roles: SET.MATCHING },
  { module: 'interviews', features: ['Calendar View', 'Interview Feedback', 'Offers', 'Joining', 'Internal Hiring'], actions: ['export'], roles: SET.MATCHING },
  { module: 'candidates', features: ['Applications'], actions: ['export'], roles: SET.MATCHING },
  // HR exports its INTERNAL hiring (scope pins it), 2026-10-03.
  { module: 'candidates', features: ['Candidate List', 'Applications'], actions: ['export'], roles: ['HR'] },
  { module: 'interviews', features: ['Calendar View', 'Interview Feedback', 'Offers', 'Joining', 'Internal Hiring'], actions: ['export'], roles: ['HR'] },
  { module: 'requirements', features: ['Job Portal Workspace'], actions: ['export'], roles: SET.MATCHING },
  { module: 'requirements', features: ['Client Job Portal'], actions: ['export'], roles: ['CLIENT'] },
  { module: 'dashboard', features: ['KPI Overview'], actions: ['export'], roles: SET.MATCHING },

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
  // AN EMPLOYEE'S OWN HRMS. Their dashboard and their payslip were the two
  // entries missing from the Employee sidebar — an employee could log their
  // attendance and apply for leave but could not see their own summary or
  // their own salary, which is the part of HRMS an employee cares about most.
  //
  // SAFE BECAUSE BOTH ARE ALREADY SELF-SCOPED. routes/hrmsDashboard.js reads
  // utils/scope.js employeeWhere() and routes/payroll.js payrollEmployeeWhere()
  // falls through to the same helper for anybody without payrollManage — for
  // an EMPLOYEE both resolve to their own row, so this grants the SCREEN and
  // not a wider set of rows. VIEW only: no create, edit, approve or configure
  // rule names EMPLOYEE anywhere.
  // §1 / §2 — A TL IS ALSO AN EMPLOYEE, so they get the same own-payslip and
  // own-dashboard view an employee has. Listing TL here rather than relying
  // on SET.HR is deliberate: the HRMS pass above strips a TL back to reads,
  // and this is a read.
  { module: 'hrms', features: ['HRMS Dashboard', 'Payroll & Compensation'], actions: ['view'], roles: ['EMPLOYEE', 'ACCOUNTANT', 'TL'] },
  { module: 'hrms', features: ['HRMS Dashboard'], actions: ['view', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Attendance & Time'], actions: ['create', 'edit', 'approve', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Leave & Holidays'], actions: ['create', 'edit', 'approve', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Performance & Development'], actions: ['create', 'edit', 'approve', 'export'], roles: SET.HR },
  // ASSIGNING TRAINING (LMS course assignment) is a lead's job, not only an
  // author's. `assign` is not a WRITE_ACTION, so the §3/§4 pass leaves it with
  // a Manager / Assistant Manager — who may then assign courses to the people
  // in their scope without being able to create or edit one. A TL's is
  // stripped by the §11 pass, but a TL reaches assignment through the
  // `create` TL_AUTHORED keeps (routes/lms.js canAssign).
  { module: 'hrms', features: ['Performance & Development'], actions: ['assign'], roles: SET.HR },
  { module: 'hrms', features: ['Employee Services'], actions: ['create', 'edit', 'approve', 'delete', 'export'], roles: SET.HR },
  // EMPLOYEE MANAGEMENT — the split the access matrix (§15) implies.
  //
  // The SCREEN moved under Administration yesterday, but the matrix gives
  // Administration to Super Admin and Admin only, while still giving a
  // Manager / STL / TL "Employees in assigned department" / "Team employees"
  // under HRMS. Those two facts are only compatible if VIEW and ADMINISTER
  // are different grants — so they are:
  //
  //   view   -> SET.HR   an HR lead reads THEIR DEPARTMENT'S employees, from
  //                      the HRMS group (nav.js HRMS_ITEMS -> "Employees"),
  //                      scoped by utils/scope.js employeeWhere().
  //   edit   -> SET.HR   a lead still maintains their own people's records.
  //   create / export / delete / approve / assign / configure -> SET.ADMIN
  //                      Add Employee, the CSV/XLSX/PDF export, Edit Scope and
  //                      the rest of the administration screen. This is the
  //                      "Administration -> Employee Management is Super Admin
  //                      / Admin only" half.
  //
  // `view` deliberately stays with SET.HR: middleware/auth.js caps.hrmsManage
  // reads it, and narrowing it would silently turn every HR lead into a
  // self-service-only login across attendance, leave and employee services.
  { module: 'hrms', features: ['Employee Management'], actions: ['view', 'edit'], roles: SET.HR },
  { module: 'hrms', features: ['Employee Management'], actions: ['create', 'export', 'delete', 'approve', 'assign', 'configure'], roles: SET.ADMIN },
  // THE HR DESK RUNS ONBOARDING AND REVIEW. "HR mail nunchi credentials send
  // chestham... submit for review chestharu, HR avi anni review chesi submit
  // chesthey lock avvali" — that whole loop is HR's, so HR needs to CREATE
  // the record, EXPORT the register and APPROVE (which is also what Reject
  // and Unlock are checked against). DELETE, ASSIGN and CONFIGURE stay with
  // SET.ADMIN above: removing a person, handing out roles and scope, and
  // changing the lock policy are administration, not HR desk work.
  { module: 'hrms', features: ['Employee Management'], actions: ['create', 'export', 'approve'], roles: SET.HR_DESK },
  // requireRole(...PAYROLL_ROLES) — payroll structures, runs, F&F, reports.
  { module: 'hrms', features: ['Payroll & Compensation'], actions: ['view', 'create', 'edit', 'approve', 'export'], roles: SET.ACCOUNTS },
  // PAYSLIPS (the user's rule, 2026-09-25): "an employee sees only their own
  // payslips; HR/Accounts/Admin in scope; Manager / Assistant Manager may view
  // but not generate or edit". HR sets CTCs and runs payroll (no `approve`:
  // marking a run paid and settling F&F stay with Accounts). A Manager and an
  // Assistant Manager get view + export — the view-only pass would strip any
  // write action anyway — and routes/payroll.js payslipReach() reads `export`
  // as "may read payslips inside my scope", which an Employee/TL never hold.
  { module: 'hrms', features: ['Payroll & Compensation'], actions: ['view', 'create', 'edit', 'export'], roles: ['HR'] },
  { module: 'hrms', features: ['Payroll & Compensation'], actions: ['view', 'export'], roles: ['MANAGER', 'ASSISTANT_MANAGER'] },
  // requireRole('SUPER_ADMIN','ADMIN') — attendance policy, payroll policy &
  // CTC settings, leave policy (POLICY_ROLES), leave balances.
  { module: 'hrms', features: ['Attendance & Time'], actions: ['configure'], roles: SET.ADMIN },
  { module: 'hrms', features: ['Leave & Holidays'], actions: ['configure'], roles: SET.ADMIN },
  { module: 'hrms', features: ['Payroll & Compensation'], actions: ['configure'], roles: SET.ADMIN },

  // --- HR oversight in ATS (product table: HRMS + ATS + Job Portal) ------
  // VIEW ONLY, on purpose. Every create / edit / approve rule above keeps its
  // own role set, so HR reads the recruitment picture and changes none of it.
  { module: 'candidates', features: '*', actions: ['view'], roles: SET.HR_ATS_VIEW },
  { module: 'interviews', features: '*', actions: ['view'], roles: SET.HR_ATS_VIEW },
  // ...EXCEPT INTERNAL HIRING, WHICH HR RUNS (the actual workflow, 2026-09-29:
  // Internal requirement → HR sourcing → Job Portal screening → Send to ATS →
  // HR Review → Dept Head / TL → Interview → Feedback → Selected → Offer →
  // Joining → HRMS). These grants act only where utils/scope.js lets HR reach
  // — TeamLink's INTERNAL openings — so HR still changes nothing on a client
  // placement. Stage ownership (STAGE_OWNERS above) still applies on top.
  { module: 'candidates', features: ['Add Candidate'], actions: ['create'], roles: SET.HR_ATS_VIEW },
  { module: 'candidates', features: ['Candidate Master', 'Resume & Scores', 'Rejection & Hold'], actions: ['edit'], roles: SET.HR_ATS_VIEW },
  { module: 'candidates', features: ['Applications', 'Pipeline Stages'], actions: ['create', 'edit'], roles: SET.HR_ATS_VIEW },
  { module: 'interviews', features: ['Schedule Interview', 'AI Interview', 'Interview Feedback', 'Offers', 'Joining'], actions: ['create', 'edit'], roles: SET.HR_ATS_VIEW },
  { module: 'requirements', features: ['Job Portal Applications'], actions: ['create'], roles: SET.HR_ATS_VIEW },

  // --- An employee's ATS: the Job Portal, and nothing else ---------------
  // THE ATS MODULES ARE VISIBLE TO AN EMPLOYEE (product table: HRMS + ATS +
  // Job Portal). An Employee was reaching the ATS group and finding only the
  // dashboard in it, because every sidebar entry below it asks for the view
  // on its own LIST feature and none of them named EMPLOYEE.
  //
  // The five LIST features are named one by one rather than granting `*`: a
  // module should open, not hand over Commercial Terms, Rejection & Hold or
  // Resume & Scores along with it.
  //
  // WHAT THEY SEE INSIDE IS STILL THEIR ATS ROLE'S BUSINESS. utils/scope.js
  // gives a login with no ATS working role no requirements, no clients and no
  // candidates, so a plain Employee opens these and finds them empty — and
  // the same screens fill the moment that person is made a Recruiter on
  // Administration -> Users, on the SAME login.
  { module: 'requirements', features: ['Requirement List', 'Job Portal Workspace'], actions: ['view'], roles: SET.EMPLOYEE_PORTAL },
  { module: 'candidates', features: ['Candidate List'], actions: ['view'], roles: SET.EMPLOYEE_PORTAL },
  { module: 'recruiterbde', features: ['Team View'], actions: ['view'], roles: SET.EMPLOYEE_PORTAL },
  { module: 'interviews', features: ['Calendar View'], actions: ['view'], roles: SET.EMPLOYEE_PORTAL },

  // --- Accounts ----------------------------------------------------------
  // requireRole(...ACCOUNTS_ROLES) — invoices, bank (router-level), office
  // (router-level).
  { module: 'accounts', features: '*', actions: ['view'], roles: SET.ACCOUNTS },
  // A Manager reads Accounts — but NOT Office & Expenses, which carries the
  // business's GSTIN, PAN and bank account and is Super Admin, Admin and
  // Accounts only (routes/office.js refuses everyone else as well).
  { module: 'accounts', features: ['Accounts Dashboard', 'Invoices', 'Bank & Reconciliation', 'Payments'], actions: ['view'], roles: ['MANAGER'] },
  { module: 'accounts', features: '*', actions: ['create', 'edit', 'delete', 'approve', 'export'], roles: SET.ACCOUNTS },
  { module: 'accounts', features: ['Invoices'], actions: ['view'], roles: ['CLIENT'] },
  { module: 'accounts', features: '*', actions: ['configure'], roles: SET.ADMIN },

  // --- Reports -----------------------------------------------------------
  // A report follows the product it reports on: an accountant does not get the
  // ATS reports, and a recruiting lead does not get the accounts ledger.
  // PER-ROLE SPEC (2026-10-03): every lead reads AND exports the reports of
  // their own scope (Manager department, Asst Manager teams, STL section,
  // TL team, BDE client performance); Internal HR the internal hiring.
  { module: 'reports', features: ['ATS Reports', 'Job Portal Reports'], actions: ['view', 'export'], roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'BDE'] },
  { module: 'reports', features: ['ATS Reports'], actions: ['view', 'export'], roles: ['HR'] },
  // RECRUITER: their own data only (scope.js RECRUITER branch) + MY RESULTS —
  // submitted, interviews, selected, joined (routes/atsReports.js
  // /my-results). Export of their own data (2026-10-03 import / export rule).
  { module: 'reports', features: ['ATS Reports'], actions: ['view'], roles: ['RECRUITER'] },
  { module: 'reports', features: ['My Results'], actions: ['view', 'export'], roles: ['RECRUITER'] },
  // A CLIENT's own company numbers (routes/portal.js /client/reports).
  { module: 'reports', features: ['Client Reports'], actions: ['view', 'export'], roles: ['CLIENT'] },
  // Accounts Reports follow Accounts — NOT automatic for an Admin either
  // (per-role spec 2026-10-03: "only if allowed" — grant in Role Catalog).
  { module: 'reports', features: ['Accounts Reports'], actions: ['view', 'export'], roles: ['SUPER_ADMIN', 'ACCOUNTANT'] },
  // HRMS Reports follow the same rule: they belong to HRMS, so the people who
  // administer HRMS records get them and nobody else does. This is the report
  // surface §6 gives HR, and it is the reason HR holds the `reports` module
  // at all — an HR login never reaches the ATS or the Accounts reports.
  { module: 'reports', features: ['HRMS Reports'], actions: ['view', 'export'], roles: SET.HR },

  // --- Administration ----------------------------------------------------
  // requireRole(...ADMIN_ROLES) throughout routes/admin.js.
  // Everything EXCEPT Departments & Teams, which stays Super-Admin-only. The
  // list is explicit rather than '*' because rules are additive: a later rule
  // can widen a grant, never narrow one.
  // PER-ROLE SPEC (2026-10-03): an Admin does NOT get Role Catalog or
  // Integrations by default — Super Admin only, grantable here.
  {
    module: 'administration',
    features: ['Company Setup', 'Users', 'Organization Structure', 'Notifications', 'Audit Logs'],
    actions: ROLE_FEATURE_ACTIONS,
    roles: SET.ADMIN,
  },
  { module: 'administration', features: ['Role Catalog', 'Integrations'], actions: ROLE_FEATURE_ACTIONS, roles: SET.SUPER },
  // VENDOR PORTAL (spec v2 §19, 2026-10-06): three Admin-side grants, Super
  // Admin / Admin only by default (Role Catalog can widen them). Accounts
  // roles reach vendor bills ONLY through accounts · Office & Expenses.
  { module: 'administration', features: ['Vendor Logins', 'Vendor Audit', 'Vendor Bills Review'], actions: ROLE_FEATURE_ACTIONS, roles: SET.ADMIN },
  // requireRole(...SUPER_ADMIN_ONLY) — create/delete departments and teams.
  { module: 'administration', features: ['Departments & Teams'], actions: ROLE_FEATURE_ACTIONS, roles: SET.SUPER },
  { module: 'administration', features: ['Departments & Teams'], actions: ['view'], roles: SET.ADMIN },
  // Notifications and Profile are everyone's.
  { module: 'administration', features: ['Notifications'], actions: ['view', 'edit'], roles: SET.EVERYONE },

  // --- AI Assistant & Agent (core) --------------------------------------
  // Every internal role may ask, speak and use the suggested prompts.
  { module: 'ai', features: ['Ask the Assistant', 'Voice Input', 'Suggested Prompts'], actions: ['view'], roles: SET.STAFF },
  // Answers from a product's data only for a role that reaches that product
  // (and aiAccessFor() still asks the LOGIN's own product role on top).
  { module: 'ai', features: ['Answers from HRMS Data'], actions: ['view'], roles: rolesReaching('hrms') },
  { module: 'ai', features: ['Answers from ATS Data'], actions: ['view'], roles: rolesReaching('ats') },
  { module: 'ai', features: ['Answers from Accounts Data'], actions: ['view'], roles: rolesReaching('accounts') },
  // The agent acting: create / edit for every internal working role (each
  // tool still re-checks the role's own permission for the real action).
  // Approve = run without the confirm step — Admin only by default (Super
  // Admin is global). Manager / Assistant Manager are view-only: the §3/§4
  // pass below strips create / edit / approve from them whatever is granted.
  // Manager / Assistant Manager act in ATS now (per-role spec 2026-10-03),
  // so the agent may act for them too — each tool re-checks can().
  { module: 'ai', features: ['Agent Actions'], actions: ['create', 'edit'], roles: ['ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR', 'RECRUITER', 'BDE', 'ACCOUNTANT', 'EMPLOYEE'] },
  { module: 'ai', features: ['Agent Actions'], actions: ['approve'], roles: ['ADMIN'] },
];

// THE RULES ABOVE ARE WRITTEN AGAINST THE OLD AREAS ('hrms' / 'Attendance &
// Time' …) on purpose: that is how every one of them was decided and audited.
// Each is expanded here onto every split-module feature that INHERITS the old
// area (roleAccess.js `src`), so a new feature starts with exactly the grant
// its area had — the engine only ever reads EFFECTIVE_RULES.
function expandRule(rule) {
  if (!isLegacyModule(rule.module)) return [rule];
  const names = rule.features === '*' ? LEGACY_MODULES[rule.module].features : rule.features;
  const byModule = {};
  names.forEach((name) => (LEGACY_INDEX[rule.module][name] || []).forEach(([m, feature]) => {
    (byModule[m] = byModule[m] || []).push(feature);
  }));
  return Object.entries(byModule).map(([m, features]) => ({ ...rule, module: m, features }));
}
const EFFECTIVE_RULES = DEFAULT_RULES.flatMap(expandRule);

// Super Admin / Admin: global. Admin still loses the SUPER-only capabilities
// above, which are listed explicitly rather than blanket-granted.
const GLOBAL_ROLES = ['SUPER_ADMIN'];

// ---------------------------------------------------------------------------
// MANAGER AND ASSISTANT MANAGER ARE VIEW-ONLY.  (§3, §4)
//
// Both keep EVERY module they had — Dashboard, HRMS, ATS, Accounts, Reports —
// and everything read-only inside them: View, Search, Filter, Sort, Open
// detail, View reports, Export where the matrix already allowed it. What they
// lose is the ability to WRITE.
//
// It is done HERE, on the defaults, and not by editing forty rules one by one,
// because doing it once is the only way it cannot be forgotten when a rule is
// added later: a new grant to MANAGER written into DEFAULT_RULES tomorrow is
// stripped by this same pass.
//
// "unless explicitly granted in Role Catalog" still works, and works exactly
// as it does for every other role: mergeAccess() lays the STORED RoleAccess
// row over these defaults, so ticking `edit` for MANAGER in Role Catalog
// grants it. This strips the DEFAULT, not the capability.
//
// `view` and `export` survive (read), and so does `assign` — re-assigning a
// requirement or naming a client's account manager is the oversight work these
// two roles are for, and §3/§4 names Create / Edit / Delete / Approve /
// configuration as what they must not do.
// ---------------------------------------------------------------------------
const VIEW_ONLY_ROLES = ['MANAGER', 'ASSISTANT_MANAGER'];
// PER-ROLE SPEC (2026-10-03): "Manager is no longer read-only in ATS". The
// pass now covers the HRMS and Accounts products and Administration only;
// in ATS (and the core Dashboard / Reports / AI modules) a Manager and an
// Assistant Manager hold what the rules give them, inside their
// departments / teams (utils/scope.js atsScopeOf).
// …and in ATS they hold EXACTLY the actions the per-role spec lists, not
// every write the shared role sets (RAISE / PIPELINE / RECRUITING) name. A
// DEFAULT only: Role Catalog can widen either role like any other.
//   Manager    jobs: create, assign recruiter / TL, activate, hold, close;
//              candidates: add, move the Manager's steps, assign owner;
//              Recruiter & BDE: reassign; interviews: schedule, reschedule,
//              feedback; clients: notes, pause / reactivate; import (dept)
//   Asst Mgr   jobs: create, assign recruiter, hold; candidates: move own
//              steps; Recruiter & BDE: reassign; interviews: schedule, feedback
const LEAD_ATS_WRITES = {
  MANAGER: {
    requirements: { 'Create Requirement': ['create'], 'Requirement Detail': ['edit', 'approve', 'assign'], 'Bulk Import': ['create'], 'Requirement Request': ['approve'] },
    clients: { 'Client Notes': ['create'], 'Pause / Reactivate Client': ['edit'], 'Bulk Import': ['create'], 'Client Portal Logins': ['approve'] },
    candidates: {
      'Add Candidate': ['create'], 'Candidate Master': ['edit'], Applications: ['create', 'edit'], 'Pipeline Stages': ['create', 'edit', 'approve', 'assign'], 'Rejection & Hold': ['edit', 'approve'], 'Bulk Import': ['create'],
    },
    recruiterbde: { 'Team View': ['assign'] },
    interviews: { 'Schedule Interview': ['create', 'edit'], 'Interview Feedback': ['create', 'edit'] },
  },
  ASSISTANT_MANAGER: {
    requirements: { 'Create Requirement': ['create'], 'Requirement Detail': ['edit', 'approve', 'assign'] },
    clients: {},
    candidates: { 'Pipeline Stages': ['edit'], 'Rejection & Hold': ['edit'] },
    recruiterbde: { 'Team View': ['assign'] },
    interviews: { 'Schedule Interview': ['create', 'edit'], 'Interview Feedback': ['create', 'edit'] },
  },
};
function viewOnlyApplies(moduleId) {
  if (isLegacyModule(moduleId)) return true;
  const p = PRODUCT_OF_MODULE[moduleId];
  return p === 'hrms' || p === 'accounts' || moduleId === 'administration';
}
// The features whose `approve` is a RUNG ON AN APPROVAL CHAIN rather than an
// edit. utils/approvalWorkflow.js routes requests through these, and a level
// that cannot act is a level the request dies at.
const APPROVAL_CHAIN_FEATURES = [
  'Leave & Holidays', 'Attendance & Time', 'Employee Services',
  'Performance & Development', 'Employee Management',
];

// §11 / §12 / §21 — A TL IS VIEW + DESIGNATED APPROVALS IN HRMS.
//
// A TL leads a team; they do not administer HR records. They held create,
// edit and delete on Attendance, Leave, Performance and Employee Services,
// and edit on Employee Management — that is HR administration, and §11 says
// Employee Master, Attendance Master and Payroll are VIEW ONLY for them.
//
// This is NOT the §3/§4 view-only pass: that one covers a Manager and an
// Assistant Manager in EVERY product. A TL is a working role in ATS — they
// move candidates and raise requirements — so the restriction is HRMS ONLY.
//
// `approve` survives, because approving a request the chain routed to them
// is the TL's designated action and the whole reason they are rung 2. So
// does `export`, which is a read.
const HRMS_VIEW_ONLY_ROLES = ['TL'];
const HRMS_STRIPPED_ACTIONS = ['create', 'edit', 'delete', 'configure', 'assign'];

// …EXCEPT WHAT §13 AND §14 EXPLICITLY ASK A TL TO RAISE.
//
// §13 is "TL Recommendation → STL → …" and §14 is "TL creates course draft
// → STL → …". Both START with a TL authoring something, so stripping
// `create` off Performance & Development would have deleted the first step
// of two workflows the same spec requires — the view-only pass and the
// chain were pulling in opposite directions and the chain is the point.
//
// Nothing is handed over by this: what a TL creates here is a REQUEST. It
// is Pending until the ladder above them approves it, so the TL still
// decides nothing on their own — see WORKFLOWS.reward / .course.
const TL_AUTHORED = { 'Performance & Development': ['create'] };
const WRITE_ACTIONS = ['create', 'edit', 'delete', 'approve', 'configure'];

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

  EFFECTIVE_RULES.forEach((rule) => {
    if (rule.module !== moduleId) return;
    if (!rule.roles.includes(role)) return;
    const targets = rule.features === '*' ? names : rule.features.filter((f) => names.includes(f));
    targets.forEach((f) => {
      rule.actions.forEach((a) => {
        if (ROLE_FEATURE_ACTIONS.includes(a)) features[f][a] = true;
      });
    });
  });

  // §3 / §4 — the view-only pass. Runs AFTER every rule has been applied, so
  // it cannot be out-run by a rule added later.
  // §3 / §4 — the view-only pass. Runs AFTER every rule has been applied, so
  // it cannot be out-run by a rule added later.
  //
  // ONE EXCEPTION, AND IT IS THE REASON THESE ROLES EXIST: taking their turn
  // on an approval chain. The Manager and the Assistant Manager are RUNGS on
  // the ladder — Employee -> TL -> STL -> Assistant Manager -> Manager -> HR
  // -> Super Admin — so stripping `approve` from them left a request routed to
  // a Manager that the Manager could not act on: a dead chain.
  //
  // Approving a request that the workflow ROUTED TO YOU is not editing a
  // record; create, edit, delete and configure are still stripped everywhere,
  // and the approval engine still refuses anybody whose turn it is not.
  if (VIEW_ONLY_ROLES.includes(role) && viewOnlyApplies(moduleId)) {
    // EXACTLY what can() allows them (viewOnlyAllows): view / export, approve
    // on the approval chain, LMS assignment. `assign` elsewhere used to
    // survive HERE while can() refused it, so the matrix /auth/me sends drew
    // Assign buttons for a Manager that the API then 403'd (review #3 access
    // audit). One rule now, in both places.
    names.forEach((f) => ROLE_FEATURE_ACTIONS.forEach((a) => {
      if (!viewOnlyAllows(f, a, moduleId)) features[f][a] = false;
    }));
  }

  // Per-role spec 2026-10-03 — Manager / Asst Manager in ATS: the listed
  // actions only (LEAD_ATS_WRITES above); view / export stay as the rules say.
  if (LEAD_ATS_WRITES[role] && LEAD_ATS_WRITES[role][moduleId]) {
    const allowed = LEAD_ATS_WRITES[role][moduleId];
    names.forEach((f) => ROLE_FEATURE_ACTIONS.forEach((a) => {
      if (['view', 'export'].includes(a)) return;
      if (!(allowed[f] || []).includes(a)) features[f][a] = false;
    }));
  }

  // §11 — the TL pass. HRMS only, and `approve` / `view` / `export` survive.
  if (PRODUCT_OF_MODULE[moduleId] === 'hrms' && HRMS_VIEW_ONLY_ROLES.includes(role)) {
    names.forEach((f) => {
      const keep = TL_AUTHORED[sourceOf(moduleId, f) || f] || [];
      HRMS_STRIPPED_ACTIONS.forEach((a) => {
        if (!keep.includes(a)) features[f][a] = false;
      });
    });
  }

  const anyGranted = names.some((f) => ROLE_FEATURE_ACTIONS.some((a) => features[f][a]));
  const listed = (DEFAULT_MODULES[role] || []).includes(moduleId);
  return { moduleEnabled: listed && anyGranted, features };
}

// Merge persisted RoleAccess row(s) over the defaults, so a feature added to
// the catalog later still works for roles saved before it existed.
//
// Rows are applied in order, so a PRODUCT-SPECIFIC row ('ats') is merged over
// the product-agnostic '*' row: a role saved before products existed keeps
// exactly the access it had, and an admin can then differ it per product.
function mergeAccess(role, moduleId, ...rows) {
  const present = rows.filter(Boolean);
  const base = defaultAccessForRole(role, moduleId);
  if (!present.length) return base;
  const mod = moduleById(moduleId);
  let out = base;
  present.forEach((row) => {
    let saved = {};
    try { saved = row.features ? JSON.parse(row.features) : {}; } catch { saved = {}; }
    const features = {};
    (mod ? mod.features : []).forEach((f) => {
      features[f] = { ...out.features[f], ...(saved[f] || {}) };
    });
    out = { moduleEnabled: !!row.moduleEnabled, features };
  });
  return out;
}

// OR together several roles' access on one module. Used for the core modules,
// which answer to every role a login holds.
function unionAccess(moduleId, list) {
  const mod = moduleById(moduleId);
  const names = mod ? mod.features : [];
  if (!list.length) return { moduleEnabled: false, features: Object.fromEntries(names.map((f) => [f, emptyActions(false)])) };
  const features = {};
  names.forEach((f) => {
    features[f] = {};
    ROLE_FEATURE_ACTIONS.forEach((a) => {
      features[f][a] = list.some((x) => !!(x.features[f] && x.features[f][a]));
    });
  });
  return { moduleEnabled: list.some((x) => x.moduleEnabled), features };
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

// accessFor(role, moduleId, product) — the stored matrix for ONE role on ONE
// module, in ONE product. `product` defaults to the module's own product key.
// The legacy area modules ('hrms' / 'accounts') answered from the split
// modules: an old feature holds an action when ANY feature inheriting it does
// (in an enabled module), and the area is enabled when any of its modules is.
function legacyView(legacyId, accessOf) {
  const features = {};
  LEGACY_MODULES[legacyId].features.forEach((name) => {
    features[name] = emptyActions(false);
    (LEGACY_INDEX[legacyId][name] || []).forEach(([m, f]) => {
      const acc = accessOf(m);
      if (!acc || !acc.moduleEnabled) return;
      ROLE_FEATURE_ACTIONS.forEach((a) => {
        if (acc.features && acc.features[f] && acc.features[f][a]) features[name][a] = true;
      });
    });
  });
  const moduleEnabled = ROLE_ACCESS_MODULES.some((m) => legacyParentOf(m.id) === legacyId && (accessOf(m.id) || {}).moduleEnabled);
  return { moduleEnabled, features };
}

async function accessFor(role, moduleId, product) {
  if (isLegacyModule(moduleId)) {
    const key = product || productKeyOf(moduleId);
    const got = {};
    for (const m of ROLE_ACCESS_MODULES.filter((x) => legacyParentOf(x.id) === moduleId)) {
      // eslint-disable-next-line no-await-in-loop
      got[m.id] = await accessFor(role, m.id, key);
    }
    return legacyView(moduleId, (m) => got[m]);
  }
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
      const star = rows.find((r) => r.moduleId === m.id && (r.product || '*') === '*');
      const byProduct = {};
      PRODUCTS.forEach((p) => {
        if (p.id === '*') { byProduct['*'] = mergeAccess(role, m.id, star); return; }
        const specific = rows.find((r) => r.moduleId === m.id && r.product === p.id);
        byProduct[p.id] = mergeAccess(role, m.id, star, specific);
      });
      modules[m.id] = byProduct;
    });
    entry = { at: now, modules };
    cache.set(role, entry);
  }
  const key = product || productKeyOf(moduleId);
  const mod = entry.modules[moduleId];
  if (!mod) return { moduleEnabled: false, features: {} };
  return mod[key] || mod['*'] || { moduleEnabled: false, features: {} };
}

// ---------------------------------------------------------------------------
// can() — the single entry point.
//
// `user` is the resolved identity (see utils/identity.js) as carried on req.user.
// `record` is optional; when given, data scope and ownership are applied too.
// ---------------------------------------------------------------------------
// Manager / Assistant Manager READ everything in their scope, and ACT only
// where the user said so (2026-09-25, second decision): they approve on the
// approval chain (leave, regularization, resignation … — the chain features)
// and they assign LMS courses (Performance & Development / assign). Nothing
// else — no create, edit, delete or configure.
const VIEW_ONLY_ACTIONS = ['view', 'export'];
const EXTERNAL_LOGIN_ROLES = ['CLIENT', 'CANDIDATE'];
const EXTERNAL_ATS_FEATURES = ['Client Job Portal', 'Client Feedback', 'Agreement Lifecycle', 'Requirement Request'];
function isExternalLogin(user) {
  if (!user) return false;
  const sr = user.scopeRoles || {};
  return [user.role, user.atsRole, sr.ats].some((r) => EXTERNAL_LOGIN_ROLES.includes(r));
}
// `moduleId` lets a split HRMS feature answer as the area it inherits
// (roleAccess.js sourceOf): Leave Approvals is on the approval chain because
// Leave & Holidays is, LMS keeps the assign exception because Performance &
// Development has it.
function viewOnlyAllows(featureName, action, moduleId) {
  const feature = (moduleId && sourceOf(moduleId, featureName)) || featureName;
  if (VIEW_ONLY_ACTIONS.includes(action)) return true;
  if (action === 'approve' && APPROVAL_CHAIN_FEATURES.includes(feature)) return true;
  if (action === 'assign' && feature === 'Performance & Development') return true;
  return false;
}

const REPORT_FEATURE_PRODUCT = {
  'ATS Reports': 'ats', 'Job Portal Reports': 'ats', 'Accounts Reports': 'accounts', 'My Results': 'ats', 'Client Reports': 'ats',
};

async function can(user, product, moduleId, feature, action, record = undefined) {
  // 1. user identity
  if (!user || !user.id) return false;
  if (user.status && user.status !== 'Active') return false;

  // 1a. LEGACY AREA NAMES. 'hrms' / 'accounts' are no longer modules of their
  //     own (roleAccess.js SPLIT_MODULES); an old guard such as
  //     ('hrms', 'Attendance & Time', 'approve') asks "does this login hold
  //     approve on ANY feature that inherits Attendance & Time?" — the same
  //     question it always asked of the one old feature.
  if (isLegacyModule(moduleId)) {
    const targets = LEGACY_INDEX[moduleId][feature] || [];
    for (const [m, f] of targets) {
      // eslint-disable-next-line no-await-in-loop
      if (await can(user, product, m, f, action, record)) return true;
    }
    return false;
  }

  // 2. ACTIVE PRODUCT
  const owningProduct = product || PRODUCT_OF_MODULE[moduleId] || null;
  const isProduct = ROLE_PRODUCTS.includes(owningProduct);
  if (isProduct && !(user.products || {})[owningProduct]) return false;
  // 2a. Reports is a core module, but its ATS / Job Portal / Accounts reports
  //     belong to a product (user, 2026-09-29: an R&D employee must not reach
  //     ATS or Job Portal reports whatever their HRMS role grants).
  if (moduleId === 'reports' && REPORT_FEATURE_PRODUCT[feature]
    && !(user.products || {})[REPORT_FEATURE_PRODUCT[feature]]) return false;

  // 2b. OUTSIDE LOGINS AND ATS (review #3 access audit). A Client or a
  //     Candidate is never a user of the internal ATS: whatever Role Catalog
  //     says, the only ATS features they may hold are their own portal's —
  //     the client-facing Job Portal, their own Client Feedback and their own
  //     agreement confirmation. Their screens are /api/portal/* and
  //     /api/job-portal/client*, which check these features.
  if (owningProduct === 'ats' && isExternalLogin(user) && !EXTERNAL_ATS_FEATURES.includes(feature)) return false;
  // 2c. CLIENT LOGIN TYPE (spec B1): Reviewer / Viewer / Billing only ever
  //     narrow what the CLIENT role holds (utils/clientPortalTypes.js).
  if (user.portalType && !require('./clientPortalTypes').portalTypeAllows(user, moduleId, feature, action)) return false; // eslint-disable-line global-require

  // 3. PRODUCT ROLE — the role for THIS product, never the account-level one.
  //    accountsRole = None means Accounts is refused however senior the
  //    login's HRMS or ATS role is.
  const roles = rolesFor(user, isProduct ? owningProduct : null);
  if (!roles.length) return false;

  // 4. module permission + 5. action permission
  const key = isProduct ? owningProduct : '*';
  let granted = false;
  for (const role of roles) {
    // MANAGER AND ASSISTANT MANAGER ARE VIEW-ONLY — every department, nothing
    // changed (the user's rule, 2026-09-25). They may look and download
    // (view / export); create, edit, approve, assign, delete and configure are
    // refused whatever a rule or Role Catalog says. Their own self-service
    // (own leave, own check-in, own profile) never goes through can(), so it
    // still works.
    if (VIEW_ONLY_ROLES.includes(role) && viewOnlyApplies(moduleId) && !viewOnlyAllows(feature, action, moduleId)) continue;
    // eslint-disable-next-line no-await-in-loop
    const access = await accessFor(role, moduleId, key);
    if (access.moduleEnabled && access.features[feature] && access.features[feature][action]) {
      granted = true;
      break;
    }
  }
  if (!granted) return false;

  // 6/7. data scope and record ownership
  if (record !== undefined && record !== null) {
    const { recordInScope } = require('./scope');
    // A split module scopes as the area it came from ('accounts' pins a
    // client's own invoices).
    if (!recordInScope(user, legacyParentOf(moduleId) || moduleId, record)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// WORKFLOW ACTIONS ARE NOT VIEW/EDIT.  (§17)
//
// Seeing a record must not imply acting on it, and holding `candidates /
// Pipeline Stages / edit` must not imply owning every stage. The pipeline has
// an OWNER at each point:
//
//   Recruiter Review   → a Recruiter may Reject / Hold / Send to BDE
//   With BDE           → a BDE may Share with Client
//   Shared with Client → a Client may Shortlist / Reject / Interview Decision
//
// Both halves are checked, in this order:
//   1. ACCESS   — can(user, 'ats', 'candidates', 'Pipeline Stages', 'edit'),
//                 the ordinary matrix answer, resolved against the ATS
//                 PRODUCT ROLE. An HRMS Manager who is not in ATS fails here.
//   2. OWNERSHIP— STAGE_OWNERS[targetStage] names the ATS roles that own the
//                 move. A Recruiter cannot Share with Client; a Client cannot
//                 move a candidate into Recruiter Review.
//
// This table used to live in routes/applications.js, which made it a SECOND
// permission system sitting beside this one. It lives here now, it is
// resolved against the ATS product role like everything else in ATS, and the
// route calls canMoveToStage().
//
// The 20 keys and their order match STAGE_CODES + EXTRA_STAGE_CODES in
// backend/src/utils/atsVocab.js. Labels are never derived from these codes.
// HR (2026-09-29, the actual workflow): HR OWNS INTERNAL HIRING — HR Review,
// forwarding to the Dept Head / TL, the interview, feedback, offer, joining
// and the HRMS hand-off. HR is on the stages below for that reason only:
// utils/scope.js pins HR to INTERNAL requirements, so these entries never
// reach a client placement. HR is deliberately NOT on SELECTED (the Dept Head
// / TL decides) and routes/applications.js lets only the Dept Head / TL (TL,
// STL) approve an internal candidate out of TL Review.
const STAGE_OWNERS = {
  NEW: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  AI_INTERVIEW_REQUIRED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  AI_INTERVIEW_SCHEDULED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  AI_INTERVIEW_COMPLETED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  RECRUITER_REVIEW: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  RECRUITER_APPROVED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  // STAGE_OWNERS[X] is "who may move a candidate INTO X", and a button's owner
  // is STAGE_OWNERS[to]. So the RECRUITER is here — forwarding into TL review is
  // their move — and is deliberately absent from WITH_BDE below, which is what
  // stops them approving their own candidate straight past the TL.
  TL_REVIEW: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  // NEITHER THE RECRUITER NOR THE BDE moves a candidate into the BDE queue —
  // the TL's Approve is what puts it there (§23). The BDE still ACTS at this
  // stage: their button is Share with Client, whose target SHARED_WITH_CLIENT
  // they do own.
  WITH_BDE: ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  BDE_APPROVED: ['BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  SHARED_WITH_CLIENT: ['BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  CLIENT_REVIEW: ['BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  CLIENT_SHORTLISTED: ['CLIENT', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  INTERVIEW_SCHEDULED: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  INTERVIEW_COMPLETED: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  SELECTED: ['CLIENT', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  OFFER: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  OFFER_ACCEPTED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  JOINED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  HIRED: ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  REJECTED: ['RECRUITER', 'BDE', 'CLIENT', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
  HOLD: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'],
};

// The named buttons §17 asks for, per CURRENT stage. `to` is the target stage,
// so the owner of the button is STAGE_OWNERS[to] and there is no second list
// to keep in step. The frontend reads the resolved form of this from
// /auth/me, so a button is shown only to the login that owns the move.
const STAGE_WORKFLOW_ACTIONS = {
  RECRUITER_REVIEW: [
    { id: 'send_to_tl', label: 'Send to TL', to: 'TL_REVIEW' },
    { id: 'hold', label: 'Hold', to: 'HOLD' },
    { id: 'reject', label: 'Reject', to: 'REJECTED' },
  ],
  TL_REVIEW: [
    { id: 'approve_to_bde', label: 'Approve', to: 'WITH_BDE' },
    { id: 'hold', label: 'Hold', to: 'HOLD' },
    { id: 'reject', label: 'Reject', to: 'REJECTED' },
  ],
  WITH_BDE: [
    { id: 'share_with_client', label: 'Share with Client', to: 'SHARED_WITH_CLIENT' },
    { id: 'hold', label: 'Hold', to: 'HOLD' },
    { id: 'reject', label: 'Reject', to: 'REJECTED' },
  ],
  SHARED_WITH_CLIENT: [
    { id: 'shortlist', label: 'Shortlist', to: 'CLIENT_SHORTLISTED' },
    { id: 'interview_decision', label: 'Interview Decision', to: 'INTERVIEW_SCHEDULED' },
    { id: 'reject', label: 'Reject', to: 'REJECTED' },
  ],
};

// STAGE OWNERSHIP FOR A CUSTOM ATS ROLE resolves against the system role it
// behaves like (req.user.scopeRoles.ats, see utils/roleRegistry.js); for a
// system role that alias is the role itself. An alias of ADMIN (scope ALL)
// owns every stage, as Admin does. Ownership only — the access half is still
// the custom role's own matrix via can().
function stageRoleOf(user) {
  const alias = user && user.scopeRoles && user.scopeRoles.ats;
  return alias && alias !== NO_ROLE ? alias : roleForProduct(user, 'ats');
}
function stageGlobal(user) {
  return rolesFor(user, null).some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r)) || stageRoleOf(user) === 'ADMIN';
}

// Which target stages this login may move a candidate to. Access half first,
// ownership half second — a login that fails the access half gets an empty
// list, not a shorter one.
async function allowedStagesFor(user) {
  const mayAct = await can(user, 'ats', 'candidates', 'Pipeline Stages', 'edit');
  if (!mayAct) return [];
  // Super Admin / Admin own every stage, as they always have.
  const global = stageGlobal(user);
  const atsRole = stageRoleOf(user);
  return Object.keys(STAGE_OWNERS)
    .filter((stage) => global || STAGE_OWNERS[stage].includes(atsRole));
}

// The guard routes/applications.js calls. Returns null when allowed, or the
// { status, body } refusal to send.
async function canMoveToStage(user, stage) {
  if (!STAGE_OWNERS[stage]) return { status: 400, body: { error: 'Unknown stage' } };
  if (!await can(user, 'ats', 'candidates', 'Pipeline Stages', 'edit')) {
    return { status: 403, body: { error: "This action isn't included in your role's permissions" } };
  }
  const global = stageGlobal(user);
  if (!global && !STAGE_OWNERS[stage].includes(stageRoleOf(user))) {
    return { status: 403, body: { error: "Moving to this stage isn't included in your role's permissions" } };
  }
  return null;
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

// Express guard for INTERNAL surfaces that are not tied to one ATS feature
// (the ATS dashboard and its alerts, the people filters): an outside login
// (Client / Candidate) is refused — its screens are /api/portal/*.
function requireInternal(req, res, next) {
  if (isExternalLogin(req.user)) return res.status(403).json({ error: 'This area is not part of your access' });
  return next();
}

// ---------------------------------------------------------------------------
// AI ASSISTANT & AGENT — the one reader of the `ai` module.
//
// aiAccessFor(user) -> {
//   ask, voice, prompts,
//   answers:      { hrms, ats, accounts },   // may answer from that product's data
//   agentActions: { create, edit, approve }, // approve = no confirm step
// }
// An EXTRA gate, never a widening: an "Answers from <product>" grant counts
// only while the login actually holds a role in that product, and whatever
// the assistant reads or the agent does is still checked by the ordinary
// can() / scope rules of that screen. Outside logins (Client / Candidate) get
// nothing, whatever a catalog row says.
// ---------------------------------------------------------------------------
async function aiAccessFor(user) {
  const none = {
    ask: false, voice: false, prompts: false,
    answers: { hrms: false, ats: false, accounts: false },
    agentActions: { create: false, edit: false, approve: false },
  };
  if (!user || !user.id || isExternalLogin(user)) return none;
  const ai = (feature, action = 'view') => can(user, null, 'ai', feature, action);
  const [ask, voice, prompts, hrms, ats, accounts, create, edit, approve] = await Promise.all([
    ai('Ask the Assistant'), ai('Voice Input'), ai('Suggested Prompts'),
    ai('Answers from HRMS Data'), ai('Answers from ATS Data'), ai('Answers from Accounts Data'),
    ai('Agent Actions', 'create'), ai('Agent Actions', 'edit'), ai('Agent Actions', 'approve'),
  ]);
  return {
    ask, voice, prompts,
    answers: {
      hrms: hrms && !!roleForProduct(user, 'hrms'),
      ats: ats && !!roleForProduct(user, 'ats'),
      accounts: accounts && !!roleForProduct(user, 'accounts'),
    },
    agentActions: { create, edit, approve },
  };
}

// ---------------------------------------------------------------------------
// IMPORT / EXPORT PER ROLE (2026-10-03) — the one reader for the data-I/O
// screens.
//
// ioAccessFor(user, moduleId) -> {
//   import:      may upload a sheet into this module at all
//   importMode:  'direct'  — rows become records (Bulk Import / create)
//                'request' — rows become REQUESTS a lead approves (Bulk
//                            Import / view without create: a BDE's client /
//                            job import)
//                null      — no import
//   export:      may download this module's rows
//   exportScope: whose rows: 'all' | 'department' | 'teams' | 'section' |
//                'team' | 'own' | 'own-clients' | 'internal' | 'billing' |
//                'own-company' | 'own-profile' | 'none'  (utils/scope.js
//                still decides the actual rows — this is the label / rule)
//   sensitive:   may export PAN / Aadhaar / bank details — the HR desk's
//                employee export (HRMS Employee Management / Export / export:
//                Super Admin, Admin, HR by default)
// }
// Configurable: every answer is a can() on the Role Catalog matrix.
// ---------------------------------------------------------------------------
const IO_MODULES = {
  requirements: { importFeature: 'Bulk Import', exportFeature: 'Requirement List', direct: ['requirements', 'Create Requirement', 'create'] },
  clients: { importFeature: 'Bulk Import', exportFeature: 'Client List', direct: ['clients', 'Add Client', 'create'] },
  candidates: { importFeature: 'Bulk Import', exportFeature: 'Candidate List', direct: ['candidates', 'Add Candidate', 'create'] },
  interviews: { importFeature: null, exportFeature: 'Calendar View' },
  recruiterbde: { importFeature: null, exportFeature: 'Team View' },
};
function ioScopeOf(user) {
  // eslint-disable-next-line global-require
  const { atsScopeOf, atsViewRole } = require('./scope');
  const s = atsScopeOf(user);
  if (s.global) return 'all';
  if (s.role === 'CANDIDATE' || s.atsRole === 'CANDIDATE') return 'own-profile';
  if (s.role === 'CLIENT' || s.atsRole === 'CLIENT') return 'own-company';
  switch (s.atsRole) {
    case 'MANAGER': return 'department';
    case 'ASSISTANT_MANAGER': return s.teamUserIds ? 'teams' : 'department';
    case 'STL': return 'section';
    case 'TL': return 'team';
    case 'RECRUITER': return 'own';
    case 'BDE': return 'own-clients';
    case 'HR': return 'internal';
    case 'ACCOUNTANT': return 'billing';
    default: return atsViewRole(user) === 'admin' ? 'all' : 'none';
  }
}
async function ioAccessFor(user, moduleId) {
  const def = IO_MODULES[moduleId];
  const none = { import: false, importMode: null, export: false, exportScope: 'none', sensitive: false };
  if (!def || !user || !user.id) return none;
  const [mayImport, importDirect, mayExport, sensitive] = await Promise.all([
    def.importFeature ? can(user, 'ats', moduleId, def.importFeature, 'view') : false,
    def.importFeature ? can(user, 'ats', moduleId, def.importFeature, 'create') : false,
    can(user, 'ats', moduleId, def.exportFeature, 'export'),
    can(user, 'hrms', 'hrms_employees', 'Export', 'export'),
  ]);
  // Direct import also needs the right to create ONE such record by hand.
  const direct = importDirect && (!def.direct || await can(user, 'ats', ...def.direct));
  return {
    import: !!mayImport,
    importMode: mayImport ? (direct ? 'direct' : 'request') : null,
    export: !!mayExport,
    exportScope: mayExport ? ioScopeOf(user) : 'none',
    sensitive: !!sensitive,
  };
}

// Role Catalog: the actions the server IGNORES for a view-only role (§3/§4),
// per feature of one module — can() and effectiveMatrix() drop them whatever
// is ticked, so the catalog greys them. null for every other role.
function viewOnlyLocksFor(role, moduleId) {
  if (!VIEW_ONLY_ROLES.includes(role) || !viewOnlyApplies(moduleId)) return null;
  const mod = moduleById(moduleId);
  if (!mod) return null;
  const out = {};
  mod.features.forEach((f) => {
    const locked = ROLE_FEATURE_ACTIONS.filter((a) => !viewOnlyAllows(f, a, moduleId));
    if (locked.length) out[f] = locked;
  });
  return out;
}

// The whole matrix for one role, in one product — what the Role Catalog reads.
async function accessMatrix(role, product) {
  const out = {};
  for (const m of ROLE_ACCESS_MODULES) {
    // eslint-disable-next-line no-await-in-loop
    out[m.id] = await accessFor(role, m.id, product);
  }
  Object.keys(LEGACY_MODULES).forEach((id) => { out[id] = legacyView(id, (m) => out[m]); });
  return out;
}

// ---------------------------------------------------------------------------
// THE EFFECTIVE MATRIX FOR ONE LOGIN — what /auth/me hands the browser.
//
// This is the whole three-role model collapsed into the one shape the
// frontend already reads, so the sidebar, the landing page and every button
// read the SAME answer can() gives: each module resolved against ITS
// product's role, the core modules against every role the login holds.
// ---------------------------------------------------------------------------
async function effectiveMatrix(user) {
  const out = {};
  for (const m of ROLE_ACCESS_MODULES) {
    const owning = PRODUCT_OF_MODULE[m.id];
    const isProduct = ROLE_PRODUCTS.includes(owning);
    if (isProduct && !(user.products || {})[owning]) {
      out[m.id] = defaultAccessForRole(NO_SUCH_ROLE, m.id);
      continue;
    }
    const roles = rolesFor(user, isProduct ? owning : null);
    const key = isProduct ? owning : '*';
    // eslint-disable-next-line no-await-in-loop
    // The same two clamps can() applies, so a button is drawn exactly when the
    // API would accept it: view-only Manager / Asst Manager (whatever a stored
    // Role Catalog row says) and outside logins in ATS (review #3 access audit).
    const external = owning === 'ats' && isExternalLogin(user);
    const list = await Promise.all(roles.map(async (r) => {
      const acc = await accessFor(r, m.id, key);
      const viewOnly = VIEW_ONLY_ROLES.includes(r) && viewOnlyApplies(m.id);
      if (!viewOnly && !external) return acc;
      const features = {};
      Object.entries(acc.features || {}).forEach(([f, actions]) => {
        features[f] = {};
        Object.entries(actions).forEach(([a, v]) => {
          features[f][a] = !!v
            && (!viewOnly || viewOnlyAllows(f, a, m.id))
            && (!external || EXTERNAL_ATS_FEATURES.includes(f));
        });
      });
      return { ...acc, features };
    }));
    out[m.id] = list.length ? unionAccess(m.id, list) : defaultAccessForRole(NO_SUCH_ROLE, m.id);
    // Client login type (spec B1) — the same clamp can() applies.
    if (user.portalType) {
      const { portalTypeAllows } = require('./clientPortalTypes'); // eslint-disable-line global-require
      Object.entries(out[m.id].features || {}).forEach(([f, actions]) => {
        Object.keys(actions).forEach((a) => { if (actions[a] && !portalTypeAllows(user, m.id, f, a)) actions[a] = false; });
      });
    }
  }
  // The legacy `hrms` / `accounts` entries, so every screen and sidebar
  // entry that reads the old area names keeps its exact answer.
  Object.keys(LEGACY_MODULES).forEach((id) => { out[id] = legacyView(id, (m) => out[m]); });
  return out;
}

module.exports = {
  PRODUCT_OF_MODULE,
  ROLE_PRODUCTS,
  DEFAULT_MODULES,
  DEFAULT_RULES,
  EFFECTIVE_RULES,
  SET,
  NO_ROLE,
  roleForProduct,
  productRolesOf,
  rolesFor,
  can,
  requirePerm,
  requireProduct,
  requireInternal,
  isExternalLogin,
  accessFor,
  accessMatrix,
  effectiveMatrix,
  defaultAccessForRole,
  mergeAccess,
  unionAccess,
  invalidateRoleAccess,
  STAGE_OWNERS,
  STAGE_WORKFLOW_ACTIONS,
  allowedStagesFor,
  canMoveToStage,
  // Super Admin / Admin (or an ADMIN-alias custom role) — exempt from the
  // stage-chain rule in routes/applications.js, as from stage ownership.
  stageGlobal,
  // The ATS role stage ownership resolves against (custom roles -> their alias).
  stageRoleOf,
  DENIED,
  // AI Assistant & Agent gate (see aiAccessFor above).
  aiAccessFor,
  viewOnlyLocksFor,
  // Import / export per role (2026-10-03) — see ioAccessFor above.
  ioAccessFor,
  IO_MODULES,
  viewOnlyApplies,
};
