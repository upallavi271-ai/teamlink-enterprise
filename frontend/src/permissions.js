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

// Reports export. Was EXPORT_ROLES.includes(role).
export const canExportReports = (user, feature) => can(user, null, 'reports', feature, 'export');

// Team-lead style oversight (the Recruiter & BDE screen, team pickers).
export const hasTeamOversight = (user) => can(user, 'ats', 'recruiterbde', 'Team View', 'view');

// External logins, for the handful of places that genuinely differ (a client
// signs an agreement; a candidate only ever sees themselves). These read the
// resolved identity's scope, not a role string.
export const isClientUser = (user) => !!(user && user.clientId && user.role === 'CLIENT');
export const isCandidateUser = (user) => !!(user && user.role === 'CANDIDATE');

// A short label for the role chip in the topbar. Product-aware: a Medical
// Recruiter reads "Recruiter · Medical", not "Medical Recruiter" — the role and
// the scope are separate things.
export function workRoleLabel(user) {
  if (!user) return '';
  const pretty = (code) => (code || '')
    .split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')
    .replace('Stl', 'STL').replace('Tl', 'TL').replace('Bde', 'BDE');
  const role = pretty(user.atsRole || user.role);
  const scope = (user.atsScopeDepartments || user.department || '').split(',')[0];
  return scope && !['Super Admin', 'Admin'].includes(role) ? `${role} · ${scope}` : role;
}
