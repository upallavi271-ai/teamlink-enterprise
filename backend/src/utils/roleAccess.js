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

const ROLE_ACCESS_MODULES = [
  { id: 'dashboard', label: 'Dashboard', features: ['KPI Overview', 'Department Strength', 'Pending Approvals', 'Alerts & Notifications', 'Upcoming Interviews', 'Quick Actions', 'Recruiter Leaderboard', 'Role & User Management'] },
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
  { id: 'requirements', label: 'Jobs / Requirements', features: ['Requirement List', 'Create Requirement', 'Requirement Detail', 'Job Posting', 'Matching Candidates', 'Requirement Pipeline', 'Job Portal Workspace', 'Job Portal Applications', 'Client Job Portal'] },
  { id: 'clients', label: 'Clients', features: ['Client List', 'Add Client', 'Client Detail', 'Agreement Lifecycle', 'Commercial Terms', 'Client Requirements'] },
  { id: 'candidates', label: 'Candidates & Pipeline', features: ['Candidate List', 'Add Candidate', 'Candidate Master', 'Applications', 'Pipeline Stages', 'Rejection & Hold', 'Resume & Scores'] },
  { id: 'recruiterbde', label: 'Recruiter & BDE', features: ['Recruiter Workload', 'BDE Workload', 'Team View', 'Pending Actions'] },
  // Interviews & Joining: Interview Calendar - Interview Feedback - Offers -
  // Joining - Internal Hiring. Client Feedback is its own feature because a
  // client submits client feedback and never internal interview feedback.
  { id: 'interviews', label: 'Interviews & Joining', features: ['Calendar View', 'Schedule Interview', 'AI Interview', 'Interview Feedback', 'Client Feedback', 'Offers', 'Joining', 'Internal Hiring'] },
  { id: 'hrms', label: 'HRMS', features: ['HRMS Dashboard', 'Attendance & Time', 'Leave & Holidays', 'Payroll & Compensation', 'Performance & Development', 'Employee Services', 'Employee Management'] },
  { id: 'accounts', label: 'Accounts', features: ['Accounts Dashboard', 'Office & Expenses', 'Invoices', 'Bank & Reconciliation', 'Payments'] },
  { id: 'reports', label: 'Reports', features: ['ATS Reports', 'Job Portal Reports', 'Accounts Reports'] },
  { id: 'administration', label: 'Administration', features: ['Company Setup', 'Users', 'Role Catalog', 'Integrations', 'Organization Structure', 'Departments & Teams', 'Notifications', 'Audit Logs'] },
];

// Roles this app actually issues, in the prototype's seniority order.
const CATALOG_ROLES = [
  'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL',
  'RECRUITER', 'BDE', 'CLIENT', 'ACCOUNTANT', 'EMPLOYEE', 'CANDIDATE',
];

// The prototype's ROLE_SCOPE_DESC, mapped onto this app's role codes.
const ROLE_SCOPE_DESC = {
  SUPER_ADMIN: 'Company-wide (all departments, full access)',
  ADMIN: 'Company-wide (all departments, full access)',
  MANAGER: 'All departments, cross-department oversight',
  ASSISTANT_MANAGER: 'All departments, cross-department oversight (restricted admin settings)',
  STL: 'All departments, cross-department oversight — single STL',
  TL: 'Single department — own team only',
  RECRUITER: 'Own assigned candidates only',
  BDE: 'BDE department workflow',
  CLIENT: 'Own company only',
  ACCOUNTANT: 'Payrolls, invoices and expenses only',
  EMPLOYEE: 'Own record only',
  CANDIDATE: 'Own profile, applications and interviews only',
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
  moduleById,
  sanitizeFeatures,
};
