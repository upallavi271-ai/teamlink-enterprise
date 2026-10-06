// Role Catalog — the module / feature / action matrix the "Edit Access" modal
// edits.
//
// The reference prototype carries TWO permission structures that were never
// reconciled with each other:
//
//   * `state.rolePermissions` (buildDefaultPermissions, prototype line 406) —
//     four modules only (candidates, requirements, clients, invoices). It has no
//     HRMS and no Accounts module at all, so it cannot describe this app.
//   * `state.roleAccess` / `roleAccessFor()` (prototype line 10073) — ten modules,
//     each with 4-8 named features, each feature carrying seven actions. This is
//     what the Role Catalog's Edit Access -> Configure screens actually read and
//     write.
//
// We follow `roleAccessFor`, because it is the one the Role Catalog UI edits and
// the only one that covers every module this app ships. The lists below are the
// prototype's verbatim (ROLE_ACCESS_MODULES / ROLE_FEATURE_ACTIONS).

// The eight actions the permission engine understands. The prototype's matrix
// carried seven; `configure` is added because settings/policy screens are a
// real, separately-grantable action (attendance policy, CTC settings, leave
// policy, integrations, the Role Catalog itself) that "edit" does not describe.
const ROLE_FEATURE_ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'assign', 'configure'];

// ---------------------------------------------------------------------------
// HRMS AND ACCOUNTS, MODULE BY MODULE (Role Catalog, 2026-09-29).
//
// HRMS used to be ONE module (`hrms`) whose seven "features" were whole areas
// (Attendance & Time, Leave & Holidays, …), and Accounts one module
// (`accounts`) with six. The Role Catalog therefore showed a single HRMS and a
// single Accounts checkbox while ATS showed every module with its features.
// Each of those areas is now a module of its own with real features, so the
// catalog reads Product → Module → Feature → Action for all three products.
//
// `legacy` is the old area the module replaces and `src` (per feature,
// defaulting to `legacy`) is the OLD feature whose grants the new feature
// inherits: the default rules, the stored Role Catalog rows (migrated once,
// 2026-09-29, old area -> every feature that inherits it), the Manager / Asst Manager approval-chain
// exception and the TL pass are all read through `src`, so on day one every
// new feature answers EXACTLY what its old area answered. A few features sit
// in a different module than their `src` because that is where the screen
// is (Shift Roster and Timesheet are Attendance screens but were always
// guarded as Employee Services records, so they inherit Employee Services).
//
// BACKWARD COMPATIBLE. `hrms` and `accounts` stay as LEGACY ALIASES:
// can(user, 'hrms', 'hrms', 'Attendance & Time', 'approve') is still valid and
// means "approve on ANY feature whose src is Attendance & Time" (see
// LEGACY_INDEX and permissions.js can()), and /auth/me still carries a
// virtual `hrms` / `accounts` entry computed the same way — so every guard,
// helper and sidebar entry written against the old names keeps working, and
// area-wide checks (the sidebar entry, self-service, caps.hrmsManage) stay
// area-wide.
//
// `api` says whether some endpoint checks the feature BY NAME. A feature
// with api: false still counts toward its module's area checks (its View opens
// the module like any other feature's) and the hint says what it drives; the
// Role Catalog marks it so no checkbox pretends to do more than it does.
// ---------------------------------------------------------------------------
const feat = (name, hint, extra = {}) => ({ name, hint, api: true, ...extra });
const SPLIT_MODULES = [
  // ---- HRMS ----------------------------------------------------------------
  {
    id: 'hrms_dashboard', label: 'HRMS Dashboard', product: 'hrms', legacyModule: 'hrms', legacy: 'HRMS Dashboard',
    features: [
      feat('HRMS Dashboard', 'The HRMS dashboard KPIs and charts (GET /api/hrms/dashboard).'),
    ],
  },
  {
    id: 'hrms_attendance', label: 'Attendance & Time', product: 'hrms', legacyModule: 'hrms', legacy: 'Attendance & Time',
    features: [
      feat('Attendance Dashboard', 'Company attendance dashboard — the API asks Export.'),
      feat('Daily Marking', 'Mark Present / Absent buttons. The mark itself is refused by the server unless the login has HR reach over that person.', { api: false }),
      feat('Biometric Attendance List', 'Date-wise biometric list of everyone in scope — the API asks Export.'),
      feat('Punch Log', 'Detailed punch log — the API asks Export.'),
      feat('Monthly Summary', 'Monthly summary and the team day view — the API asks Export.'),
      feat('Regularization', 'Approve / reject regularization requests (Approve).'),
      feat('Attendance Report', 'Attendance report download — the API asks Export.'),
      feat('Import History', 'Old-HRMS attendance history: list and samples (Export), import (Configure).'),
      feat('Attendance Policy', 'Grace time / half-day / full-day policy (Configure).'),
      feat('Check-in Alerts', 'Check-in alert rules (Configure).'),
      feat('Shift Patterns', 'Shift pattern master (Create / Edit).'),
      feat('Shift Roster', 'Shift roster records (Create / Edit / Approve / Export).', { src: 'Employee Services' }),
      feat('Timesheet', 'Timesheet records (Create / Edit / Approve / Export).', { src: 'Employee Services' }),
    ],
  },
  {
    id: 'hrms_leave', label: 'Leave & Holidays', product: 'hrms', legacyModule: 'hrms', legacy: 'Leave & Holidays',
    features: [
      feat('Leave Requests', 'Opens Leave & Holidays and its Requests tab. Applying for and cancelling one’s own leave is self-service.', { api: false }),
      feat('Leave Approvals', 'Approve / reject / reassign leave requests (Approve).'),
      feat('Leave Balances', 'Balance register export (Export), set balances and apply beyond balance (Configure).'),
      feat('Leave Reports', 'Month-wise report download and on-leave-today (Export).'),
      feat('Holidays', 'Holiday calendar: add (Create), edit / delete (Edit), export (Export).'),
      feat('Leave Policy', 'Leave types, reasons, concurrency, approval levels and the TL rule (Configure).'),
    ],
  },
  {
    id: 'hrms_payroll', label: 'Payroll & Compensation', product: 'hrms', legacyModule: 'hrms', legacy: 'Payroll & Compensation',
    features: [
      feat('Salary Structures', 'Salary structures / CTC per employee (Edit), reference structure (View).'),
      feat('Payroll Runs', 'Preview (Edit), run (Create), mark paid (Approve) and the payroll run board (Create = prepare, Approve, Export = read).'),
      feat('Payslips', 'Payslips of others in scope (Export). Own payslips are self-service.'),
      feat('Payroll Reports', 'Payroll reports (Edit).'),
      feat('Full & Final', 'F&F settlements: list (Edit), process (Approve).'),
      feat('Payroll Policy & CTC', 'Payroll policy and CTC settings (Configure).'),
    ],
  },
  {
    id: 'hrms_performance', label: 'Performance & Development', product: 'hrms', legacyModule: 'hrms', legacy: 'Performance & Development',
    features: [
      feat('Performance Reviews', 'Performance reviews: add (Create), decide (Approve).'),
      feat('Monthly Targets', 'Monthly targets (Create / Edit / Approve / Export).', { src: 'Employee Services' }),
      feat('Reward & Recognition', 'Recognition records (Create / Edit / Approve / Export).', { src: 'Employee Services' }),
      feat('Nominations', 'Recognition nominations: nominate (Create), review (Approve).'),
      feat('Knowledge Transfer', 'KT records (Create / Edit / Approve / Export).', { src: 'Employee Services' }),
      feat('KT Weekly Ideas', 'Weekly ideas board (View).'),
      feat('Disciplinary Actions', 'Disciplinary records (Create / Edit / Approve / Export).', { src: 'Employee Services' }),
      feat('LMS', 'Courses: view (View), author (Create / Edit), approve (Approve), assign (Assign).'),
      feat('Projects', 'Projects: add (Create), assign people (Edit).'),
    ],
  },
  {
    id: 'hrms_services', label: 'Employee Services', product: 'hrms', legacyModule: 'hrms', legacy: 'Employee Services',
    features: [
      feat('Helpdesk', 'Tickets: assign / escalate / notes (Edit), analytics (Export).'),
      feat('Assets', 'Asset inventory and asset requests (Create / Edit / Approve / Export).'),
      feat('Documents', 'Company documents: publish (Create), visibility (Edit), delete (Delete).'),
      feat('Resignation', 'Resignations: decide (Approve), summary (Export), form (Configure).'),
      feat('Announcements', 'Announcements: post (Create), pin (Edit), delete (Delete).'),
      feat('Engagement Surveys', 'Surveys: create (Create), open / close (Edit).'),
      feat('Expense Claims', 'Expense & travel claims (Create / Edit / Approve / Export).'),
      feat('Tasks', 'Tasks: open the screen (View), assign to others (Create), edit (Edit), review (Approve).'),
      feat('Access Requests', 'Access requests (Create / Edit / Approve / Export).'),
    ],
  },
  {
    id: 'hrms_employees', label: 'Employee Management', product: 'hrms', legacyModule: 'hrms', legacy: 'Employee Management',
    features: [
      feat('Employee List', 'Employee list, detail, photo and history (View).'),
      feat('Add Employee', 'Add Employee, next employee ID and e-mail OTP (Create).'),
      feat('Edit Employee', 'Edit a record, reporting manager, last working day, on/offboarding (Edit); delete (Delete).'),
      feat('Change Employee ID', 'Change an employee’s ID (Edit).'),
      feat('Logins & Passwords', 'Create / toggle a login, reset password (Edit), send credentials (Configure).'),
      feat('Roles & Scope', 'Product roles (Edit), data scope and linked login (Assign).'),
      feat('Profile Review & Locks', 'Review queue (View), approve / reject changes and unlocks (Approve), lock / pause (Configure).'),
      feat('Transfers', 'Transfer an employee (Assign).'),
      feat('TL-wise View', 'TL-wise team summary (View) and its download (Export).'),
      feat('Bulk Import', 'Bulk employee import, its fields and sample (Create).'),
      feat('Export', 'Employee exports — list, global, single record (Export).'),
    ],
  },
  // ---- Accounts --------------------------------------------------------------
  {
    id: 'accounts_dashboard', label: 'Accounts Dashboard', product: 'accounts', legacyModule: 'accounts', legacy: 'Accounts Dashboard',
    features: [
      feat('Accounts Dashboard', 'The Accounts dashboard (View).'),
    ],
  },
  {
    id: 'accounts_office', label: 'Office & Expenses', product: 'accounts', legacyModule: 'accounts', legacy: 'Office & Expenses',
    features: [
      feat('Expenses & Bills', 'Record / edit / delete expenses and proofs (Edit), approve / pay (Approve), register and ledger downloads (Export).'),
      feat('Vendors', 'Add vendors (Edit).'),
      feat('Expense Categories', 'Add / change expense categories (Edit).'),
      feat('Business Profile & Tax Portals', 'Business profile, portal links and balances, GST / TDS portal logins (Edit).'),
      feat('GST Reconciliation', 'GST reconciliation (View).'),
      feat('Due Dates & Reminders', 'Statutory due dates and reminders (View).'),
    ],
  },
  {
    id: 'accounts_invoices', label: 'Invoices', product: 'accounts', legacyModule: 'accounts', legacy: 'Invoices',
    features: [
      feat('Invoice Register', 'Raise invoices (Create), mark sent / paid / cancelled (Edit), register download (Export).'),
      feat('Joining Invoices', 'Raise an invoice from a joining (Create).'),
      feat('TDS Certificates', 'Record and upload TDS certificates (Edit).'),
      feat('Client Agreements', 'The Accounts → Client Agreements sidebar entry.', { api: false }),
    ],
  },
  {
    id: 'accounts_bank', label: 'Bank & Reconciliation', product: 'accounts', legacyModule: 'accounts', legacy: 'Bank & Reconciliation',
    features: [
      feat('Bank Accounts', 'Add / edit / delete bank accounts and opening balances (Edit).'),
      feat('Statement Import', 'Import statements, manual entries, delete imports and duplicates (Edit).'),
      feat('Match & Categorise', 'Match, reconcile, ignore, categorise and settle bank lines; rules and marks (Edit).'),
      feat('Hand Loans', 'Hand loans and their links (Edit).'),
    ],
  },
  {
    id: 'accounts_payments', label: 'Payments', product: 'accounts', legacyModule: 'accounts', legacy: 'Payments',
    features: [
      feat('Invoice Payments', 'Record a payment against an invoice (Create), remove one (Delete).'),
    ],
  },
  {
    id: 'accounts_journal', label: 'Journal & Ledger', product: 'accounts', legacyModule: 'accounts', legacy: 'Journal & Ledger',
    features: [
      feat('Journal', 'Chart of accounts and journal entries (View), post a manual entry (Create).'),
      feat('Ledger', 'The ledger (View).'),
      feat('Payroll Reconciliation', 'Payroll reconciliation report (View).'),
      feat('Payroll Posting', 'Payroll run board: read (View), post / mark paid (Create), approve (Approve).'),
    ],
  },
];

// The two legacy area modules, as they were — the names old guards still use.
const LEGACY_MODULES = {
  hrms: { label: 'HRMS', product: 'hrms', features: ['HRMS Dashboard', 'Attendance & Time', 'Leave & Holidays', 'Payroll & Compensation', 'Performance & Development', 'Employee Services', 'Employee Management'] },
  accounts: { label: 'Accounts', product: 'accounts', features: ['Accounts Dashboard', 'Office & Expenses', 'Invoices', 'Bank & Reconciliation', 'Payments', 'Journal & Ledger'] },
};

// sourceOf(moduleId, feature) -> the legacy feature it inherits, or null for a
// module that was never split (ATS, core).
const SOURCE = {};
SPLIT_MODULES.forEach((m) => {
  SOURCE[m.id] = {};
  m.features.forEach((x) => { SOURCE[m.id][x.name] = x.src || m.legacy; });
});
function sourceOf(moduleId, feature) {
  return (SOURCE[moduleId] && SOURCE[moduleId][feature]) || null;
}

// LEGACY_INDEX.hrms['Attendance & Time'] -> [[moduleId, feature], …]: every
// new feature that inherits that old one.
const LEGACY_INDEX = {};
Object.entries(LEGACY_MODULES).forEach(([id, def]) => {
  LEGACY_INDEX[id] = {};
  def.features.forEach((name) => { LEGACY_INDEX[id][name] = []; });
});
SPLIT_MODULES.forEach((m) => m.features.forEach((x) => {
  LEGACY_INDEX[m.legacyModule][x.src || m.legacy].push([m.id, x.name]);
}));
const isLegacyModule = (id) => Object.prototype.hasOwnProperty.call(LEGACY_MODULES, id);
// The legacy module a split module belongs to ('hrms' | 'accounts'), or null.
function legacyParentOf(moduleId) {
  const m = SPLIT_MODULES.find((x) => x.id === moduleId);
  return m ? m.legacyModule : null;
}
// Expand a module-id list: 'hrms' / 'accounts' -> their split modules.
function expandModuleIds(list) {
  const out = [];
  (list || []).forEach((id) => {
    if (isLegacyModule(id)) SPLIT_MODULES.filter((m) => m.legacyModule === id).forEach((m) => out.push(m.id));
    else out.push(id);
  });
  return [...new Set(out)];
}
// Per-feature hint / enforcement flag, for the Role Catalog.
function featureInfoOf(moduleId) {
  const m = SPLIT_MODULES.find((x) => x.id === moduleId);
  if (!m) return null;
  const out = {};
  m.features.forEach((x) => { out[x.name] = { hint: x.hint, api: x.api !== false, inherits: x.src || m.legacy }; });
  return out;
}

const ROLE_ACCESS_MODULES = [
  // 'System Alerts' (per-role spec 2026-10-03): the company-wide system
  // warnings — Job Portal connection / sync failures and AI credits. Super
  // Admin by default; Admin only when granted here.
  { id: 'dashboard', label: 'Dashboard', features: ['KPI Overview', 'Department Strength', 'Pending Approvals', 'Alerts & Notifications', 'Upcoming Interviews', 'Quick Actions', 'Recruiter Leaderboard', 'Role & User Management', 'System Alerts'] },
  // Job Portal is NOT a module of its own. It is three features of Jobs /
  // Requirements, because that is where the work sits:
  //   Job Portal Workspace     — the internal Publish → Sync → Applications →
  //                              Import to ATS → Candidate Pipeline screen.
  //                              view / edit (publish) / configure (sync).
  //   Job Portal Applications  — the applications arriving from a portal.
  //                              view / create (import into the pipeline).
  //   Client Job Portal        — the CLIENT-facing view: their own published
  //                              requirements and the candidates shared with
  //                              them. A client holds this and never the two
  //                              features above, which is exactly why they can
  //                              never reach the internal workspace.
  // 'Requirement Request' (per-role spec 2026-10-03): ASK for a new job
  // instead of creating it. A BDE (who may no longer create a job) and a
  // CLIENT (portal "new requirement request") hold `create`; the request is
  // saved as a DRAFT requirement that a lead activates (Requirement Detail /
  // approve). Bulk Import with Requirement Request but no Create Requirement
  // = import as requests (permissions.js ioAccessFor importMode 'request').
  { id: 'requirements', label: 'Jobs / Requirements', features: ['Requirement List', 'Create Requirement', 'Requirement Detail', 'Job Posting', 'Matching Candidates', 'Requirement Pipeline', 'Job Portal Workspace', 'Job Portal Applications', 'Client Job Portal', 'Bulk Import', 'Requirement Request'] },
  // 'Bulk Import' (requirements + clients, 2026-09-29 role specs): the Import
  // and Template buttons. Separate from Create / Add Client because a TL may
  // raise ONE requirement but not import a sheet, and a BDE may add their own
  // client but not bulk-import clients.
  // Client lifecycle (2026-10-03): 'Pause / Reactivate Client' — edit = pause
  // or reactivate directly, create = only REQUEST a pause (an Admin / Manager
  // approves); 'Archive Client' — edit; 'Delete Client' — delete (permanent,
  // empty clients only; the route enforces emptiness). 'Client Notes' —
  // create = add a note to the client's Activity.
  { id: 'clients', label: 'Clients', features: ['Client List', 'Add Client', 'Client Detail', 'Agreement Lifecycle', 'Commercial Terms', 'Client Requirements', 'Bulk Import', 'Client Notes', 'Pause / Reactivate Client', 'Archive Client', 'Delete Client', 'Client Portal Logins'] },
  // 'Bulk Import' on candidates (2026-10-03): the candidate / application
  // sheet import, separate from adding one candidate by hand.
  { id: 'candidates', label: 'Candidates & Pipeline', features: ['Candidate List', 'Add Candidate', 'Candidate Master', 'Applications', 'Pipeline Stages', 'Rejection & Hold', 'Resume & Scores', 'Bulk Import', 'Candidate Portal Invite'] },
  { id: 'recruiterbde', label: 'Recruiter & BDE', features: ['Recruiter Workload', 'BDE Workload', 'Team View', 'Pending Actions'] },
  // Interviews & Joining: Interview Calendar - Interview Feedback - Offers -
  // Joining - Internal Hiring. Client Feedback is its own feature because a
  // client submits client feedback and never internal interview feedback.
  { id: 'interviews', label: 'Interviews & Joining', features: ['Calendar View', 'Schedule Interview', 'AI Interview', 'Interview Feedback', 'Client Feedback', 'Offers', 'Joining', 'Internal Hiring'] },
  // HRMS and Accounts are listed MODULE BY MODULE, exactly like ATS — see
  // SPLIT_MODULES above.
  ...SPLIT_MODULES.map(({ id, label, features }) => ({ id, label, features: features.map((f) => f.name) })),
  // HRMS Reports is a feature of its own, beside the ATS and the Accounts
  // ones, because a report follows the product it reports on: the HR desk
  // (§6) reads HRMS reporting and never the recruitment or the finance
  // ledgers, and an accountant never reads the HRMS ones.
  // AI Assistant & Agent (2026-09-29): which parts of the in-app assistant and
  // agent a role may use. A CORE module — resolved against every role the login
  // holds — and an EXTRA gate only: the assistant still reads only what the
  // login could read itself, and the agent only does what the login could do
  // itself (every tool re-checks can()). Approve on Agent Actions = may run
  // an action without the confirm step. permissions.js aiAccessFor() is the
  // one reader.
  { id: 'ai', label: 'AI Assistant & Agent', features: ['Ask the Assistant', 'Voice Input', 'Suggested Prompts', 'Answers from HRMS Data', 'Answers from ATS Data', 'Answers from Accounts Data', 'Agent Actions'] },
  // 'My Results' — a recruiter's own numbers (submitted, interviews, selected,
  // joined); 'Client Reports' — a client's own company numbers on the portal.
  { id: 'reports', label: 'Reports', features: ['ATS Reports', 'Job Portal Reports', 'Accounts Reports', 'HRMS Reports', 'My Results', 'Client Reports'] },
  { id: 'administration', label: 'Administration', features: ['Company Setup', 'Users', 'Role Catalog', 'Integrations', 'Organization Structure', 'Departments & Teams', 'Notifications', 'Audit Logs', 'Vendor Logins', 'Vendor Audit', 'Vendor Bills Review'] },
];

// ---------------------------------------------------------------------------
// THE PRODUCT DIMENSION — Product → Module → Feature → Action.
//
// A module belongs to exactly one product, or to none. `null` = an always-on
// core surface (dashboard, reports, administration) that is not part of any
// one product and is resolved against every role the login holds.
//
// This lived in permissions.js. It moves here because the Role Catalog now
// groups its modules by product and roleAccess.js must not import
// permissions.js (permissions.js imports this file).
// ---------------------------------------------------------------------------
const PRODUCTS = [
  { id: 'ats', label: 'ATS' },
  { id: 'hrms', label: 'HRMS' },
  { id: 'accounts', label: 'Accounts' },
  { id: '*', label: 'Core (all products)' },
];

const PRODUCT_OF_MODULE = {
  dashboard: null,
  requirements: 'ats',
  clients: 'ats',
  candidates: 'ats',
  recruiterbde: 'ats',
  interviews: 'ats',
  // Legacy aliases (see SPLIT_MODULES) and the split modules themselves.
  hrms: 'hrms',
  accounts: 'accounts',
  ...Object.fromEntries(SPLIT_MODULES.map((m) => [m.id, m.product])),
  reports: null,
  administration: null,
  ai: null,
};

// The RoleAccess.product value a module's rows are stored under. A
// product-agnostic module stores '*'.
function productKeyOf(moduleId) {
  return PRODUCT_OF_MODULE[moduleId] || '*';
}

// "No role in this product." Stored on User.hrmsRole / atsRole / accountsRole
// and on DesignationRole, and refused outright by the engine.
const NO_ROLE = 'NONE';

// Roles this app actually issues, in the prototype's seniority order.
// 'HR' (§6) sits with the other people who administer HRMS records. It is an
// HRMS-ONLY role: HRMS + HRMS Reports + Dashboard, every employee in the
// company visible, and no ATS or Accounts reach whatsoever unless that person
// is separately given a role in those products.
const CATALOG_ROLES = [
  'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR',
  'RECRUITER', 'BDE', 'CLIENT', 'ACCOUNTANT', 'EMPLOYEE', 'CANDIDATE',
];

// The prototype's ROLE_SCOPE_DESC, mapped onto this app's role codes.
const ROLE_SCOPE_DESC = {
  SUPER_ADMIN: 'Whole company — every department, full access',
  ADMIN: 'Whole company — every department, full access',
  MANAGER: 'ATS: their department(s) — create / assign / activate / hold / close jobs, move Manager steps; HRMS: whole company, view and export only (approves on the approval chain, assigns LMS courses)',
  ASSISTANT_MANAGER: 'ATS: their assigned team(s) (their department when no team is set) — create jobs, assign, hold; Clients view only; HRMS: view and export only (approval chain, LMS assignment)',
  STL: 'Own section (department): its teams, TLs and recruiters, plus the unassigned openings; Clients names only',
  TL: 'Own team: team requirements and the team’s candidates (TL Review); Clients name only',
  HR: 'Every employee in HRMS; in ATS only Internal Hiring (TeamLink’s own openings) — no client jobs, no Clients, no Recruiter & BDE',
  RECRUITER: 'Own jobs, own candidates, own interviews and own results; a client’s NAME on their requirements only; own HRMS record',
  BDE: 'Own clients, their jobs and the candidates submitted to them (no recruiter notes / internal scores); requests jobs, does not create them; own HRMS record',
  CLIENT: 'Own company only — its requirements, the candidates shared with it, interviews, joinings and agreement',
  ACCOUNTANT: 'Accounts (invoices, payments, expenses, payroll accounts); no ATS',
  EMPLOYEE: 'Own HRMS record only; no ATS work until given an ATS role',
  CANDIDATE: 'Own profile, own applications and own interviews only',
};

// Default module reach, the per-role capability table and the RoleAccess merge
// now live in ./permissions.js. This file stays pure catalog data plus the
// payload sanitiser, so permissions.js can require it without a cycle.

function moduleById(id) {
  return ROLE_ACCESS_MODULES.find((m) => m.id === id) || null;
}

// Normalise an incoming feature payload down to known features and actions, so
// the client cannot write arbitrary keys into the stored JSON.
function sanitizeFeatures(moduleId, incoming) {
  const mod = moduleById(moduleId);
  if (!mod) return {};
  const out = {};
  mod.features.forEach((f) => {
    const given = (incoming && incoming[f]) || {};
    out[f] = {};
    ROLE_FEATURE_ACTIONS.forEach((a) => { out[f][a] = !!given[a]; });
  });
  return out;
}

module.exports = {
  ROLE_FEATURE_ACTIONS,
  ROLE_ACCESS_MODULES,
  CATALOG_ROLES,
  ROLE_SCOPE_DESC,
  PRODUCTS,
  PRODUCT_OF_MODULE,
  productKeyOf,
  NO_ROLE,
  moduleById,
  sanitizeFeatures,
  SPLIT_MODULES,
  LEGACY_MODULES,
  LEGACY_INDEX,
  sourceOf,
  isLegacyModule,
  legacyParentOf,
  expandModuleIds,
  featureInfoOf,
};
