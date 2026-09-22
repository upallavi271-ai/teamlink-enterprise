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
  PORTAL_ACT: ['SUPER_ADMIN', 'ADMIN', 'TL', 'RECRUITER', 'BDE'],
  // Everyone who works inside TeamLink (no external logins).
  STAFF: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR', 'RECRUITER', 'BDE', 'ACCOUNTANT', 'EMPLOYEE'],
  EVERYONE: ALL_ROLES,
};

// Which modules a role navigates to before anyone edits its access.
const DEFAULT_MODULES = {
  SUPER_ADMIN: ROLE_ACCESS_MODULES.map((m) => m.id),
  ADMIN: ROLE_ACCESS_MODULES.map((m) => m.id),
  MANAGER: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'accounts', 'reports'],
  ASSISTANT_MANAGER: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  STL: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  // `reports` is in both of these because DEFAULT_RULES below already grants a
  // TL and a BDE the ATS and Job Portal reports (view, and export for a TL) —
  // the module list was the only thing withholding them, which made the grant
  // unreachable and, until routes/reports.js was guarded, made the endpoint
  // answer anyway. Listing it here is what those two rules always meant.
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
  HR: ['dashboard', 'hrms', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'reports'],
  // A recruiter reads the client directory (their requirements name a client)
  // but cannot create or edit one — see DEFAULT_RULES.
  RECRUITER: ['dashboard', 'requirements', 'clients', 'candidates', 'interviews', 'recruiterbde', 'hrms'],
  BDE: ['dashboard', 'requirements', 'clients', 'candidates', 'recruiterbde', 'interviews', 'hrms', 'reports'],
  // A client reaches the `clients` module only to read and e-sign their OWN
  // company record — utils/scope.js pins it to their clientId.
  CLIENT: ['dashboard', 'requirements', 'clients', 'candidates', 'interviews', 'accounts'],
  // An accountant is an employee: Accounts per the catalog, HRMS self-service.
  // ACCOUNTANT — ACCOUNTS ONLY, as the product table says. `hrms` is gone
  // from this list deliberately.
  ACCOUNTANT: ['dashboard', 'accounts', 'reports'],
  // EMPLOYEE — HRMS + ATS + Job Portal per the product table. With no ATS
  // ROLE they reach the modules and see nothing in them, because
  // utils/scope.js gives an ATS-roleless login no requirements, no
  // candidates and no clients. Being made a Recruiter on Users is what
  // fills them, on the SAME login.
  EMPLOYEE: ['dashboard', 'hrms', 'requirements', 'clients', 'candidates', 'interviews', 'reports'],
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
    roles: [...SET.MATCHING, ...SET.HR_ATS_VIEW, 'CLIENT'],
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
  { module: 'hrms', features: ['HRMS Dashboard', 'Payroll & Compensation'], actions: ['view'], roles: ['EMPLOYEE'] },
  { module: 'hrms', features: ['HRMS Dashboard'], actions: ['view', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Attendance & Time'], actions: ['create', 'edit', 'approve', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Leave & Holidays'], actions: ['create', 'edit', 'approve', 'export'], roles: SET.HR },
  { module: 'hrms', features: ['Performance & Development'], actions: ['create', 'edit', 'approve', 'export'], roles: SET.HR },
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
  // requireRole('SUPER_ADMIN','ADMIN') — attendance policy, payroll policy &
  // CTC settings, leave policy (POLICY_ROLES), leave balances.
  { module: 'hrms', features: ['Attendance & Time'], actions: ['configure'], roles: SET.ADMIN },
  { module: 'hrms', features: ['Leave & Holidays'], actions: ['configure'], roles: SET.ADMIN },
  { module: 'hrms', features: ['Payroll & Compensation'], actions: ['configure'], roles: SET.ADMIN },

  // --- HR oversight in ATS (product table: HRMS + ATS + Job Portal) ------
  // VIEW ONLY, on purpose. Every create / edit / approve rule above keeps its
  // own role set, so HR reads the recruitment picture and changes none of it.
  { module: 'clients', features: '*', actions: ['view'], roles: SET.HR_ATS_VIEW },
  { module: 'candidates', features: '*', actions: ['view'], roles: SET.HR_ATS_VIEW },
  { module: 'interviews', features: '*', actions: ['view'], roles: SET.HR_ATS_VIEW },
  { module: 'recruiterbde', features: '*', actions: ['view'], roles: SET.HR_ATS_VIEW },

  // --- An employee's ATS: the Job Portal, and nothing else ---------------
  { module: 'requirements', features: ['Job Portal Workspace'], actions: ['view'], roles: SET.EMPLOYEE_PORTAL },

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

  // §3 / §4 — the view-only pass. Runs AFTER every rule has been applied, so
  // it cannot be out-run by a rule added later.
  if (VIEW_ONLY_ROLES.includes(role)) {
    names.forEach((f) => WRITE_ACTIONS.forEach((a) => { features[f][a] = false; }));
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
async function accessFor(role, moduleId, product) {
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
async function can(user, product, moduleId, feature, action, record = undefined) {
  // 1. user identity
  if (!user || !user.id) return false;
  if (user.status && user.status !== 'Active') return false;

  // 2. ACTIVE PRODUCT
  const owningProduct = product || PRODUCT_OF_MODULE[moduleId] || null;
  const isProduct = ROLE_PRODUCTS.includes(owningProduct);
  if (isProduct && !(user.products || {})[owningProduct]) return false;

  // 3. PRODUCT ROLE — the role for THIS product, never the account-level one.
  //    accountsRole = None means Accounts is refused however senior the
  //    login's HRMS or ATS role is.
  const roles = rolesFor(user, isProduct ? owningProduct : null);
  if (!roles.length) return false;

  // 4. module permission + 5. action permission
  const key = isProduct ? owningProduct : '*';
  let granted = false;
  for (const role of roles) {
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
    if (!recordInScope(user, moduleId, record)) return false;
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
const STAGE_OWNERS = {
  NEW: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  AI_INTERVIEW_REQUIRED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  AI_INTERVIEW_SCHEDULED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  AI_INTERVIEW_COMPLETED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  RECRUITER_REVIEW: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  RECRUITER_APPROVED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  // STAGE_OWNERS[X] is "who may move a candidate INTO X", and a button's owner
  // is STAGE_OWNERS[to]. So the RECRUITER is here — forwarding into TL review is
  // their move — and is deliberately absent from WITH_BDE below, which is what
  // stops them approving their own candidate straight past the TL.
  TL_REVIEW: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  // NEITHER THE RECRUITER NOR THE BDE moves a candidate into the BDE queue —
  // the TL's Approve is what puts it there (§23). The BDE still ACTS at this
  // stage: their button is Share with Client, whose target SHARED_WITH_CLIENT
  // they do own.
  WITH_BDE: ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  BDE_APPROVED: ['BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  SHARED_WITH_CLIENT: ['BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  CLIENT_REVIEW: ['BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  CLIENT_SHORTLISTED: ['CLIENT', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  INTERVIEW_SCHEDULED: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  INTERVIEW_COMPLETED: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  SELECTED: ['CLIENT', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  OFFER: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  OFFER_ACCEPTED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  JOINED: ['RECRUITER', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  HIRED: ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  REJECTED: ['RECRUITER', 'BDE', 'CLIENT', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
  HOLD: ['RECRUITER', 'BDE', 'TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'],
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

// Which target stages this login may move a candidate to. Access half first,
// ownership half second — a login that fails the access half gets an empty
// list, not a shorter one.
async function allowedStagesFor(user) {
  const mayAct = await can(user, 'ats', 'candidates', 'Pipeline Stages', 'edit');
  if (!mayAct) return [];
  // Super Admin / Admin own every stage, as they always have.
  const global = rolesFor(user, null).some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r));
  const atsRole = roleForProduct(user, 'ats');
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
  const global = rolesFor(user, null).some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r));
  if (!global && !STAGE_OWNERS[stage].includes(roleForProduct(user, 'ats'))) {
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

// The whole matrix for one role, in one product — what the Role Catalog reads.
async function accessMatrix(role, product) {
  const out = {};
  for (const m of ROLE_ACCESS_MODULES) {
    // eslint-disable-next-line no-await-in-loop
    out[m.id] = await accessFor(role, m.id, product);
  }
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
    const list = await Promise.all(roles.map((r) => accessFor(r, m.id, key)));
    out[m.id] = list.length ? unionAccess(m.id, list) : defaultAccessForRole(NO_SUCH_ROLE, m.id);
  }
  return out;
}

module.exports = {
  PRODUCT_OF_MODULE,
  ROLE_PRODUCTS,
  DEFAULT_MODULES,
  DEFAULT_RULES,
  SET,
  NO_ROLE,
  roleForProduct,
  productRolesOf,
  rolesFor,
  can,
  requirePerm,
  requireProduct,
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
  DENIED,
};
