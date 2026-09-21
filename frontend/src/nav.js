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

// leaf: { to, label, perms: [[module, feature, action], ...], product }
// A leaf with several perms needs all of them.
const leaf = (to, label, perms, product) => ({ to, label, perms, product });

// Internal-staff gate, reused by the tabs a client or candidate login has no
// business seeing. It is a permission, not a role test: 'Matching Candidates'
// is granted to every internal ATS role and to no external login.
const INTERNAL = ['requirements', 'Matching Candidates', 'view'];

export const HRMS_ITEMS = [
  leaf('/hrms', 'HRMS Dashboard', [['hrms', 'HRMS Dashboard', 'view']]),
  leaf('/my-profile', 'My Profile', null),
  leaf('/attendance', 'Attendance & Time', [['hrms', 'Attendance & Time', 'view']]),
  leaf('/leave', 'Leave & Holidays', [['hrms', 'Leave & Holidays', 'view']]),
  leaf('/payroll', 'Payroll & Compensation', [['hrms', 'Payroll & Compensation', 'view']]),
  leaf('/performance', 'Performance & Development', [['hrms', 'Performance & Development', 'view']]),
  leaf('/employee-services', 'Employee Services', [['hrms', 'Employee Services', 'view']]),
];

export const ATS_ITEMS = [
  leaf('/ats/dashboard', 'Dashboard', [['dashboard', 'Pending Approvals', 'view']], 'ats'),
  {
    id: 'clients-requirements',
    label: 'Clients & Requirements',
    children: [
      leaf('/clients', 'Clients', [['clients', 'Client List', 'view']]),
      leaf('/requirements', 'Requirements', [['requirements', 'Requirement List', 'view']]),
      leaf('/ats/agreements', 'Agreements', [['clients', 'Agreement Lifecycle', 'view']]),
      leaf('/ats/job-portal', 'Job Portal / Integrations', [['requirements', 'Job Posting', 'view'], INTERNAL]),
    ],
  },
  {
    id: 'candidates-pipeline',
    label: 'Candidates & Pipeline',
    children: [
      leaf('/candidates', 'All Candidates', [['candidates', 'Candidate List', 'view']]),
      leaf('/candidates?status=Active', 'Pipeline', [['candidates', 'Pipeline Stages', 'view']]),
      leaf(
        '/candidates?stage=NEW,AI_INTERVIEW_REQUIRED,AI_INTERVIEW_SCHEDULED,AI_INTERVIEW_COMPLETED,RECRUITER_REVIEW',
        'Screening / Follow-ups',
        [['candidates', 'Applications', 'view']],
      ),
      leaf('/candidates?stage=HOLD', 'Hold', [['candidates', 'Rejection & Hold', 'view']]),
      leaf('/candidates?view=rejected', 'Rejected', [['candidates', 'Rejection & Hold', 'view']]),
      leaf('/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED', 'Selected', [['candidates', 'Pipeline Stages', 'view']]),
    ],
  },
  {
    id: 'recruiter-bde',
    label: 'Recruiter & BDE',
    children: [
      leaf('/ats/team?tab=recruiters', 'Recruiters', [['recruiterbde', 'Recruiter Workload', 'view']]),
      leaf('/ats/team?tab=bdes', 'BDEs', [['recruiterbde', 'BDE Workload', 'view']]),
      leaf('/ats/team?tab=assignments', 'Assignments', [['recruiterbde', 'Team View', 'view']]),
      leaf('/ats/team?tab=workload', 'Workload', [['recruiterbde', 'Recruiter Workload', 'view']]),
      leaf('/ats/team?tab=pending', 'Pending Actions', [['recruiterbde', 'Pending Actions', 'view']]),
    ],
  },
  {
    id: 'interviews-joining',
    label: 'Interviews & Joining',
    children: [
      leaf('/ats/calendar', 'Interview Calendar', [['interviews', 'Calendar View', 'view']]),
      leaf('/ats/calendar?tab=feedback', 'Interview Feedback', [['interviews', 'Interview Feedback', 'view']]),
      leaf('/candidates?stage=SELECTED,OFFER', 'Offers', [['candidates', 'Pipeline Stages', 'view']]),
      leaf('/candidates?stage=OFFER_ACCEPTED,JOINED,HIRED', 'Joining', [['candidates', 'Pipeline Stages', 'view']]),
      leaf('/ats/internal-hiring', 'Internal Hiring', [['requirements', 'Create Requirement', 'create'], INTERNAL]),
    ],
  },
  leaf('/reports/ats', 'Reports', [['reports', 'ATS Reports', 'view']]),
];

export const ACCOUNTS_ITEMS = [
  leaf('/accounts/dashboard', 'Dashboard', [['accounts', 'Accounts Dashboard', 'view']], 'accounts'),
  leaf('/office', 'Office / Business', [['accounts', 'Office & Expenses', 'view']]),
  leaf('/invoices', 'Invoices', [['accounts', 'Invoices', 'view']]),
  leaf('/bank', 'Bank & Reconciliation', [['accounts', 'Bank & Reconciliation', 'view']]),
];

export const ADMIN_ITEMS = [
  leaf('/admin/company', 'Company Setup', [['administration', 'Company Setup', 'view']]),
  leaf('/admin/departments', 'Departments & Teams', [['administration', 'Departments & Teams', 'view']]),
  // Employee Management is an HRMS feature the Administration group links to,
  // so HR roles reach it without being given the Administration module.
  leaf('/employees', 'Employee Management', [['hrms', 'Employee Management', 'view']]),
  leaf('/admin/users', 'Users', [['administration', 'Users', 'view']]),
  leaf('/admin/roles', 'Role Catalog', [['administration', 'Role Catalog', 'view']]),
  leaf('/admin/integrations', 'Integrations', [['administration', 'Integrations', 'view']]),
  leaf('/admin/org-structure', 'Organization Structure', [['administration', 'Organization Structure', 'view']]),
  // Notifications and Profile are everyone's, whatever their role.
  leaf('/admin/notifications', 'Notifications', null),
  leaf('/admin/audit', 'Audit Logs', [['administration', 'Audit Logs', 'view']]),
  leaf('/admin/profile', 'Profile', null),
];

export const REPORTS_ITEMS = [
  leaf('/reports/ats', 'ATS Reports', [['reports', 'ATS Reports', 'view']]),
  leaf('/reports/job-portal', 'Job Portal Reports', [['reports', 'Job Portal Reports', 'view']]),
  leaf('/reports/accounts', 'Accounts Reports', [['reports', 'Accounts Reports', 'view']]),
];

function leafVisible(user, item) {
  if (item.product && !(user?.products || {})[item.product]) return false;
  if (!item.perms) return true;                       // Notifications, Profile, My Profile
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
  add('hrms', 'HRMS', HRMS_ITEMS);
  add('ats', 'ATS', ATS_ITEMS);
  add('accounts', 'Accounts', ACCOUNTS_ITEMS);
  add('reports', 'Reports', REPORTS_ITEMS);
  add('admin', 'Administration', ADMIN_ITEMS);
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
  [/^\/(ats|requirements|clients|candidates)/, 'ats'],
  [/^\/(accounts|invoices|bank|office)/, 'accounts'],
  [/^\/reports/, 'reports'],
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
