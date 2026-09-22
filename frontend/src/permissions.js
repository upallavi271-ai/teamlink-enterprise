// ---------------------------------------------------------------------------
// The frontend half of the permission engine.
//
// It does not decide anything. /auth/me hands the browser the SAME resolved
// identity and the SAME module/feature/action matrix the server enforces
// (backend/src/utils/permissions.js), and this file just reads it. Hiding a
// button here is a courtesy; the refusal always comes from the API.
//
// Every former `user.role === 'X'` / `ROLES.includes(user.role)` check in the
// app now goes through can() or one of the named helpers below.
//
// ONE LOGIN, THREE PRODUCT ROLES. The matrix /auth/me sends is already the
// EFFECTIVE one for this login: the server resolved each module against the
// role for ITS product (HRMS by hrmsRole, ATS by atsRole, Accounts by
// accountsRole) and the core modules against every role the login holds. So
// can() below needs to know nothing about the three roles — it reads the one
// answer the server gave, which is exactly the answer the API will enforce.
// ---------------------------------------------------------------------------

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

// can(user, product, module, feature, action) — the same signature as the
// server's. `product` may be null; the module's own product is used then.
export function can(user, product, moduleId, feature, action) {
  if (!user) return false;
  if (user.status && user.status !== 'Active') return false;
  const owning = product || PRODUCT_OF_MODULE[moduleId] || null;
  if (owning && ['hrms', 'ats', 'accounts'].includes(owning)) {
    if (!(user.products || {})[owning]) return false;
  }
  const mod = (user.access || {})[moduleId];
  if (!mod || !mod.moduleEnabled) return false;
  const actions = (mod.features || {})[feature];
  return !!(actions && actions[action]);
}

// Is a whole module reachable at all? Drives the sidebar groups.
export function canModule(user, moduleId) {
  if (!user) return false;
  const owning = PRODUCT_OF_MODULE[moduleId];
  if (owning && !(user.products || {})[owning]) return false;
  const mod = (user.access || {})[moduleId];
  return !!(mod && mod.moduleEnabled);
}

// Can the user do ANY of these actions on a feature? (button-group visibility)
export function canAny(user, moduleId, feature, actions) {
  return actions.some((a) => can(user, null, moduleId, feature, a));
}

// --- Named helpers, one per pattern the screens used to hard-code ----------

// "HR" — someone who administers other people's HRMS records, rather than only
// their own. Was HR_ROLES.includes(user.role).
export const isHR = (user) => can(user, 'hrms', 'hrms', 'Employee Management', 'view');

// Company-wide administration. Was ['SUPER_ADMIN','ADMIN'].includes(role).
export const isAdmin = (user) => canModule(user, 'administration')
  && can(user, null, 'administration', 'Users', 'edit');

export const isSuperAdmin = (user) => can(user, null, 'administration', 'Departments & Teams', 'create');

// Accounts write access. Was ACCOUNTS_ROLES.includes(role).
export const canManageAccounts = (user) => can(user, 'accounts', 'accounts', 'Invoices', 'edit');

// Payroll. Was PAYROLL_ROLES.includes(role).
export const canRunPayroll = (user) => can(user, 'hrms', 'hrms', 'Payroll & Compensation', 'create');

// Policy / settings screens. Was ['SUPER_ADMIN','ADMIN'].includes(role).
export const canEditPolicy = (user, feature) => can(user, 'hrms', 'hrms', feature, 'configure');

// ATS pipeline actions. Was CAN_ACT / PIPELINE_ROLES / RAISE_ROLES.
export const canActOnPipeline = (user) => can(user, 'ats', 'candidates', 'Pipeline Stages', 'edit');
export const canRaiseRequirement = (user) => can(user, 'ats', 'requirements', 'Create Requirement', 'create');
export const canEditRequirement = (user) => can(user, 'ats', 'requirements', 'Requirement Detail', 'edit');
export const canManageAgreement = (user) => can(user, 'ats', 'clients', 'Agreement Lifecycle', 'edit');
export const canSignAgreement = (user) => can(user, 'ats', 'clients', 'Agreement Lifecycle', 'approve')
  && !canManageAgreement(user);

// --- Job Portal -----------------------------------------------------------
// Three features of the `requirements` module, not a module of their own, so
// the sidebar, the tab strip and the buttons all read the SAME matrix the API
// enforces. Nothing here is a role test; an accountant, an HRMS-only
// employee, a client and a candidate simply do not hold these features.
export const canSeePortalWorkspace = (user) => can(user, 'ats', 'requirements', 'Job Portal Workspace', 'view');
export const canPublishToPortal = (user) => can(user, 'ats', 'requirements', 'Job Portal Workspace', 'edit');
// Sync and Open Job Portal are TWO DIFFERENT ACTIONS and two different
// answers. Sync writes; opening the portal is a link anyone in the workspace
// may follow.
export const canSyncPortal = (user) => can(user, 'ats', 'requirements', 'Job Portal Workspace', 'configure');
export const canOpenJobPortal = (user) => canSeePortalWorkspace(user);
export const canSeePortalApplications = (user) => can(user, 'ats', 'requirements', 'Job Portal Applications', 'view');
export const canImportPortalApplication = (user) => can(user, 'ats', 'requirements', 'Job Portal Applications', 'create');
export const canSeeClientPortal = (user) => can(user, 'ats', 'requirements', 'Client Job Portal', 'view');
// A client's decision on a candidate shared with them — shortlist, reject,
// request an interview. Its own action, so a read-only client login is one
// un-ticked box in Role Catalog.
export const canDecideAsClient = (user) => can(user, 'ats', 'requirements', 'Client Job Portal', 'edit');

// Reports export. Was EXPORT_ROLES.includes(role).
export const canExportReports = (user, feature) => can(user, null, 'reports', feature, 'export');

// Team-lead style oversight (the Recruiter & BDE screen, team pickers).
export const hasTeamOversight = (user) => can(user, 'ats', 'recruiterbde', 'Team View', 'view');

// --- The three product roles ----------------------------------------------
// For LABELS and for the handful of screens that pick a layout by working
// role (the ATS dashboards). Never for a permission decision — that is can().
const NO_ROLE = 'NONE';
const named = (v) => (v && v !== NO_ROLE ? v : null);

export function productRole(user, product) {
  if (!user || !(user.products || {})[product]) return null;
  const stored = product === 'hrms' ? user.hrmsRole
    : product === 'ats' ? user.atsRole
      : user.accountsRole;
  return named(stored) || user.role || null;
}

export function productRoles(user) {
  return {
    hrms: productRole(user, 'hrms'),
    ats: productRole(user, 'ats'),
    accounts: productRole(user, 'accounts'),
  };
}

// --- Workflow actions (§17) ------------------------------------------------
// Seeing a record does not mean acting on it, and being able to edit one does
// not mean owning its current stage. The server resolves BOTH halves — the
// matrix answer and the stage ownership — and sends the result as
// user.workflow.allowedStages, so a button is drawn only for the login that
// owns that move. Nothing here re-decides it.
export const workflowStages = (user) => (user && user.workflow && user.workflow.allowedStages) || [];
export const canMoveToStage = (user, stage) => workflowStages(user).includes(stage);

// The named buttons for the stage a record is sitting at, already filtered to
// the ones this login owns: Recruiter Review → Reject / Hold / Send to BDE;
// With BDE → Share with Client; Shared with Client → Shortlist / Reject /
// Interview Decision.
export function workflowActionsAt(user, stage) {
  const all = (user && user.workflow && user.workflow.stageActions) || {};
  return (all[stage] || []).filter((a) => canMoveToStage(user, a.to));
}

// External logins, for the handful of places that genuinely differ (a client
// signs an agreement; a candidate only ever sees themselves). These read the
// resolved identity's scope, not a role string.
export const isClientUser = (user) => !!(user && user.clientId && user.role === 'CLIENT');
export const isCandidateUser = (user) => !!(user && user.role === 'CANDIDATE');

// A short label for the role chip in the topbar. Product-aware twice over:
//   * it names the role for the workspace the user is actually IN, because a
//     login that is an Employee in HRMS and a Recruiter in ATS has no single
//     role to print; and
//   * a Medical Recruiter reads "Recruiter · Medical", never "Medical
//     Recruiter" — the role and the scope are separate things and no role
//     name anywhere carries a department.
export function prettyRole(code) {
  return (code || '')
    .split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')
    // Initialisms. 'Hr' is anchored so it can never rewrite a word that merely
    // starts with those two letters.
    .replace('Stl', 'STL').replace('Tl', 'TL').replace('Bde', 'BDE')
    .replace(/\bHr\b/, 'HR');
}

export function workRoleLabel(user, workspace) {
  if (!user) return '';
  const ws = workspace || user.workspace;
  const forWorkspace = ws === 'hrms' ? productRole(user, 'hrms')
    : ws === 'accounts' ? productRole(user, 'accounts')
      : ws === 'ats' ? productRole(user, 'ats')
        : null;
  const role = prettyRole(forWorkspace || user.atsRole || user.role);
  const scope = (user.atsScopeDepartments || user.department || '').split(',')[0];
  return scope && !['Super Admin', 'Admin'].includes(role) ? `${role} · ${scope}` : role;
}
