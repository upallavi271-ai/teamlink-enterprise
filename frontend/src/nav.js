// ---------------------------------------------------------------------------
// The navigation tree, in one place.
//
// HRMS, Accounts, Reports and Administration keep the prototype's flat
// grouping. ATS is two levels deep — module, then the tabs inside it —
// because the ATS is where the work happens and a flat list of twenty entries
// is not navigable:
//
//   ATS
//     Dashboard
//     Clients & Requirements   -> Clients / Requirements / Agreements /
//                                 Job Portal / Integrations
//     Candidates & Pipeline    -> All Candidates / Pipeline /
//                                 Screening / Follow-ups / Hold /
//                                 Rejected / Selected
//     Recruiter & BDE          -> Recruiters / BDEs / Assignments /
//                                 Workload / Pending Actions
//     Interviews & Joining     -> Interview Calendar / Interview Feedback /
//                                 Offers / Joining / Internal Hiring
//     Reports
//
// Hold, Rejected and Selected are VIEWS of the candidate list, not modules of
// their own, so they are query-string links into it. The separate top-level
// "Clients" and "Jobs / Requirements" entries are gone: they are tabs of
// Clients & Requirements now.
//
// Every entry names the (module, feature, action) it needs and is rendered
// only when the permission engine says the signed-in user may have it. This is
// the same matrix the API enforces (backend/src/utils/permissions.js) — the
// nav is not a second permission system, and hiding an item is never the
// control; the API still refuses the request.
// ---------------------------------------------------------------------------
import { can, canModule } from './permissions';

export const SECTION_LABEL = {
  dashboard: 'Dashboard', hrms: 'HRMS', ats: 'ATS',
  accounts: 'Accounts', admin: 'Administration', reports: 'Reports',
};

// ---------------------------------------------------------------------------
// EXTERNAL LOGINS NEVER SEE AN INTERNAL PRODUCT NAME.
//
// A Client and a Candidate are outside this company. "HRMS" is our own word
// for our own staff records and it must not appear on any surface they can
// reach — not in the sidebar, not in the topbar, not in a breadcrumb. Neither
// role is granted the hrms module, so in practice these labels never render
// for them; this mapping is what makes that true by construction rather than
// by luck, so a future grant cannot leak the word.
//
// Every place that prints a section label goes through sectionLabel() below.
// ---------------------------------------------------------------------------
export const EXTERNAL_ROLES = ['CLIENT', 'CANDIDATE'];

export function isExternalUser(user) {
  return EXTERNAL_ROLES.includes(user?.role) || EXTERNAL_ROLES.includes(user?.atsRole);
}

const EXTERNAL_SECTION_LABEL = {
  dashboard: 'Dashboard',
  hrms: 'My Workspace',
  ats: 'Recruitment',
  accounts: 'Billing',
  admin: 'Settings',
  reports: 'Reports',
};

export function sectionLabel(section, user) {
  if (isExternalUser(user)) return EXTERNAL_SECTION_LABEL[section] || SECTION_LABEL[section] || 'Dashboard';
  return SECTION_LABEL[section] || 'Dashboard';
}

// ---------------------------------------------------------------------------
// May this login RENDER this URL at all?
//
// The routes in App.jsx are not individually permission-guarded: any signed-in
// user who types a path gets the screen's chrome, and only the data behind it
// is refused by the API. For a member of staff that is harmless. For a Client
// or a Candidate it is not — typing /hrms or /employees printed internal
// vocabulary ("HRMS Dashboard", "HRMS Role") at somebody outside the company.
//
// So this narrows EXTERNAL logins only, and nothing else: an internal login's
// behaviour is unchanged. An external login may render the sections whose
// product they actually hold, plus their own Notifications and Profile.
// ---------------------------------------------------------------------------
const ALWAYS_OPEN_PATHS = ['/admin/notifications', '/admin/profile'];

export function mayRenderSection(user, pathname) {
  if (!isExternalUser(user)) return true;
  if (ALWAYS_OPEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return true;
  const products = user?.products || {};
  switch (sectionOf(pathname)) {
    case 'hrms': return !!products.hrms;
    case 'accounts': return !!products.accounts;
    case 'ats': return !!products.ats;
    // Administration proper — Users, Role Catalog, Employee Management and the
    // rest — is never an outsider's screen.
    case 'admin': return false;
    default: return true;
  }
}

// leaf: { to, label, perms: [[module, feature, action], ...], product }
// A leaf with several perms needs all of them.
const leaf = (to, label, perms, product) => ({ to, label, perms, product });

export const HRMS_ITEMS = [
  leaf('/hrms', 'HRMS Dashboard', [['hrms', 'HRMS Dashboard', 'view']]),
  leaf('/attendance', 'Attendance & Time', [['hrms', 'Attendance & Time', 'view']]),
  leaf('/leave', 'Leave & Holidays', [['hrms', 'Leave & Holidays', 'view']]),
  leaf('/payroll', 'Payroll & Compensation', [['hrms', 'Payroll & Compensation', 'view']]),
  leaf('/performance', 'Performance & Development', [['hrms', 'Performance & Development', 'view']]),
  leaf('/employee-services', 'Employee Services', [['hrms', 'Employee Services', 'view']]),
];

// The reference prototype's ATS navigation is flat — six entries, no
// sub-tabs (see SUBNAV.ats in teamlink-enterprise_69.html, line 2179).
// Clients and Jobs / Requirements stay separate, and the calendar keeps its
// own entry. The Agreements, Offers, Joining, Internal Hiring and Interview
// Feedback screens still exist and are still routed — they are reachable by
// URL and from the screens that link to them, just not listed here.
export const ATS_ITEMS = [
  leaf('/ats/dashboard', 'Dashboard', [['dashboard', 'Pending Approvals', 'view']], 'ats'),
  leaf('/requirements', 'Jobs / Requirements', [['requirements', 'Requirement List', 'view']]),
  // NO "Job Portal" ENTRY HERE, DELIBERATELY. The Job Portal is not a
  // top-level ATS module; it is a workspace INSIDE Jobs / Requirements —
  //   Jobs / Requirements → Job Portal → Publish → Sync → Applications
  //   → Import to ATS → Candidate Pipeline
  // — so it is reached from the Clients · Requirements · Agreements · Job
  // Portal tab strip (components/ClientModuleTabs.jsx), which is what "inside
  // Jobs / Requirements" means in this navigation. That strip picks the
  // internal workspace or the client-facing view from the SAME permission
  // matrix the API enforces, so the ATS sidebar stays flat, exactly as the
  // reference prototype has it.
  leaf('/clients', 'Clients', [['clients', 'Client List', 'view']]),
  leaf('/candidates', 'Candidates & Pipeline', [['candidates', 'Candidate List', 'view']]),
  leaf('/ats/team', 'Recruiter & BDE', [['recruiterbde', 'Team View', 'view']]),
  leaf('/ats/calendar', 'Interview Calendar', [['interviews', 'Calendar View', 'view']]),
];

export const ACCOUNTS_ITEMS = [
  leaf('/accounts/dashboard', 'Dashboard', [['accounts', 'Accounts Dashboard', 'view']], 'accounts'),
  leaf('/office', 'Office / Business', [['accounts', 'Office & Expenses', 'view']]),
  leaf('/invoices', 'Invoices', [['accounts', 'Invoices', 'view']]),
  leaf('/bank', 'Bank & Reconciliation', [['accounts', 'Bank & Reconciliation', 'view']]),
];

// ADMINISTRATION — Super Admin and Admin only.
//
// EVERY entry here now names an `administration` permission, and nothing else
// does. The engine only switches the administration MODULE on for a role that
// is listed for it (permissions.js DEFAULT_MODULES), so a Recruiter, TL, BDE,
// Accountant, Employee, Client or Candidate matches none of these and
// visibleItems() returns an empty list — which makes groupsForUser() drop the
// whole "Administration" group rather than show a one-item stub.
//
// One entry changed to make that true:
//   * Notifications and Profile were `perms: null` — always visible — which
//     kept the group alive for literally everyone, including a candidate.
//     Notifications is reachable from the bell in the topbar whatever your
//     role; the page itself is still routed and still open to everyone at
//     /admin/notifications and /admin/profile. Only the menu entry is gated.
//
// Grant a role the administration module in Role Catalog and the group comes
// back for it — "unless an administration permission was deliberately
// granted" is exactly what this expresses.
export const ADMIN_ITEMS = [
  leaf('/admin/company', 'Company Setup', [['administration', 'Company Setup', 'view']]),
  leaf('/admin/departments', 'Departments & Teams', [['administration', 'Departments & Teams', 'view']]),
  // Employee Management is its own module under Administration. Its permission
  // stays the HRMS one deliberately: the screen is scoped, so an HR role — a
  // TL, an STL, a Manager — still reaches their own department's employees
  // without being granted the administration module. The consequence is that
  // such a login sees an Administration group containing only this entry.
  leaf('/employees', 'Employee Management', [['hrms', 'Employee Management', 'view']]),
  leaf('/admin/users', 'Users', [['administration', 'Users', 'view']]),
  leaf('/admin/roles', 'Role Catalog', [['administration', 'Role Catalog', 'view']]),
  leaf('/admin/integrations', 'Integrations', [['administration', 'Integrations', 'view']]),
  leaf('/admin/org-structure', 'Organization Structure', [['administration', 'Organization Structure', 'view']]),
  leaf('/admin/notifications', 'Notifications', [['administration', 'Notifications', 'view']]),
  leaf('/admin/audit', 'Audit Logs', [['administration', 'Audit Logs', 'view']]),
  leaf('/admin/profile', 'Profile', [['administration', 'Users', 'view']]),
];

export const REPORTS_ITEMS = [
  leaf('/reports/ats', 'ATS Reports', [['reports', 'ATS Reports', 'view']]),
  leaf('/reports/job-portal', 'Job Portal Reports', [['reports', 'Job Portal Reports', 'view']]),
  leaf('/reports/accounts', 'Accounts Reports', [['reports', 'Accounts Reports', 'view']]),
];

function leafVisible(user, item) {
  if (item.product && !(user?.products || {})[item.product]) return false;
  if (!item.perms) return true;                       // Notifications, Profile
  return item.perms.every(([m, f, a]) => (f ? can(user, null, m, f, a) : canModule(user, m)));
}

// Filter a group's items, dropping any section left with no visible tab.
export function visibleItems(user, items) {
  return items
    .map((item) => {
      if (!item.children) return leafVisible(user, item) ? item : null;
      const kids = item.children.filter((c) => leafVisible(user, c));
      return kids.length ? { ...item, children: kids } : null;
    })
    .filter(Boolean);
}

// Group render order is the prototype's: HRMS, ATS, Accounts, Reports,
// Administration. Which groups and which items appear is decided entirely by
// the permission matrix.
export function groupsForUser(user) {
  const groups = [];
  const add = (id, label, items) => {
    const shown = visibleItems(user, items);
    if (shown.length) groups.push([id, label, shown]);
  };
  // Labels come from sectionLabel(), so an external login can never be shown
  // an internal product name in the sidebar.
  add('hrms', sectionLabel('hrms', user), HRMS_ITEMS);
  add('ats', sectionLabel('ats', user), ATS_ITEMS);
  add('accounts', sectionLabel('accounts', user), ACCOUNTS_ITEMS);
  add('reports', sectionLabel('reports', user), REPORTS_ITEMS);
  add('admin', sectionLabel('admin', user), ADMIN_ITEMS);
  return groups;
}

// Every leaf of every group, flattened, carrying its section and its parent.
export function flattenGroups(groups) {
  const out = [];
  groups.forEach(([s, , items]) => items.forEach((item) => {
    if (item.children) item.children.forEach((c) => out.push({ ...c, section: s, parent: item }));
    else out.push({ ...item, section: s, parent: null });
  }));
  return out;
}

// Which sidebar section a URL belongs to, so the group opens and the topbar
// title / breadcrumb name the right section.
const SECTION_OF_PATH = [
  [/^\/(hrms|attendance|leave|payroll|performance|employee-services|my-profile)/, 'hrms'],
  [/^\/(ats|requirements|clients|candidates|client-portal)/, 'ats'],
  [/^\/(accounts|invoices|bank|office)/, 'accounts'],
  [/^\/reports/, 'reports'],
  // /employees is Employee Management, its own module under Administration.
  [/^\/(admin|employees)/, 'admin'],
];
export function sectionOf(pathname) {
  const hit = SECTION_OF_PATH.find(([re]) => re.test(pathname));
  return hit ? hit[1] : 'dashboard';
}

// Several tabs now point at the same screen with different query strings
// (Hold, Rejected and Selected are all the candidate list), so "which nav
// entry am I on" has to compare the query too, not just the path.
export function scoreMatch(to, pathname, search) {
  const [toPath, toQuery] = to.split('?');
  if (toQuery) {
    if (pathname !== toPath) return 0;
    const here = new URLSearchParams(search);
    const want = new URLSearchParams(toQuery);
    let ok = true;
    want.forEach((v, k) => { if (here.get(k) !== v) ok = false; });
    if (!ok) return 0;
    return 1000 + toQuery.length + (here.toString() === want.toString() ? 500 : 0);
  }
  if (pathname === toPath) return search ? 100 : 900 + toPath.length;
  if (pathname.startsWith(`${toPath}/`)) return 200 + toPath.length;
  return 0;
}
