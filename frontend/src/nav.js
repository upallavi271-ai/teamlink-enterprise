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
import { can, canModule, productRole } from './permissions';

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
  switch (sectionOf(pathname, user)) {
    case 'hrms': return !!products.hrms;
    case 'accounts': return !!products.accounts;
    case 'ats': return !!products.ats;
    // Administration proper — Users, Role Catalog, Employee Management and the
    // rest — is never an outsider's screen.
    case 'admin': return false;
    default: return true;
  }
}

// leaf: { icon, to, label, perms: [[module, feature, action], ...], product }
// A leaf with several perms needs all of them.
// `unless` is the mirror of `perms`: an entry carrying it is hidden from a
// login that HAS those permissions. One entry needs it — HRMS -> Employees,
// which exists for the leads who do not reach Administration.
//
// THE ICONS (§19) ARE DECORATION AND NOTHING ELSE.
//
// One emoji per entry, the user's own mapping, rendered by Shell.jsx in a
// fixed-width column so every label still starts on the same vertical line.
// Where this app has an entry their list does not name — Performance &
// Development, Departments & Teams, the three report screens, the public Job
// Portal link — the icon is picked from the same visual family, and a report
// of a product carries that product's own icon.
//
// No icon takes part in a permission decision. `perms` is untouched by the
// icon pass: which entries exist, and who may see them, is unchanged.
const leaf = (icon, to, label, perms, product, unless) => ({
  icon, to, label, perms, product, unless,
});

// The group headings, and the standalone Dashboard entry above them.
export const SECTION_ICON = {
  dashboard: '🏠', hrms: '👥', ats: '🎯',
  accounts: '💰', reports: '📊', admin: '⚙️',
};

export const HRMS_ITEMS = [
  leaf('📊', '/hrms', 'HRMS Dashboard', [['hrms', 'HRMS Dashboard', 'view']]),
  // THE EMPLOYEE'S OWN RECORD — their complete employee form and documents
  // (pages/hrms/MyProfile.jsx). It was reachable only from banners and the
  // dashboard button, so an employee with nothing pending had no way back to
  // it. Every HRMS login is somebody's employee record, so it needs no
  // permission beyond holding HRMS; the API resolves the record from the
  // login and never from a parameter. Super Admin / Admin logins are service
  // accounts with no employee record behind them, so `unless` keeps a
  // dead-end entry out of their sidebar (Administration -> Profile still
  // links here for the rare admin who does have one).
  leaf('🪪', '/my-profile', 'My Employee Profile', null, 'hrms', [['administration', 'Users', 'view']]),
  // "Employees in assigned department" / "Team employees" (§15). The SAME
  // screen and the SAME scoped endpoint as Administration -> Employee
  // Management; only the entry point differs, and `unless` keeps Super Admin
  // and Admin from seeing it listed twice (they get the Administration one).
  leaf('👤', '/employees', 'Employees', [['hrms', 'Employee Management', 'view']], null,
    [['administration', 'Users', 'view']]),
  // Positions & Seat History moved to Administration -> Positions & Seat History
  // (/admin/positions?tab=history); /hrms/seat-history redirects there.
  leaf('🕐', '/attendance', 'Attendance & Time', [['hrms', 'Attendance & Time', 'view']]),
  leaf('🏖️', '/leave', 'Leave & Holidays', [['hrms', 'Leave & Holidays', 'view']]),
  leaf('💵', '/payroll', 'Payroll & Compensation', [['hrms', 'Payroll & Compensation', 'view']]),
  leaf('📈', '/performance', 'Performance & Development', [['hrms', 'Performance & Development', 'view']]),
  leaf('🛎️', '/employee-services', 'Employee Services', [['hrms', 'Employee Services', 'view']]),
];

// The reference prototype's ATS navigation is flat — six entries, no
// sub-tabs (see SUBNAV.ats in teamlink-enterprise_69.html, line 2179).
// Clients and Jobs / Requirements stay separate, and the calendar keeps its
// own entry. The Agreements, Offers, Joining, Internal Hiring and Interview
// Feedback screens still exist and are still routed — they are reachable by
// URL and from the screens that link to them, just not listed here.
export const ATS_ITEMS = [
  leaf('📊', '/ats/dashboard', 'Dashboard', [['dashboard', 'Pending Approvals', 'view']], 'ats'),
  leaf('💼', '/requirements', 'Jobs / Requirements', [['requirements', 'Requirement List', 'view']]),
  // NO "Job Portal" ENTRY HERE, DELIBERATELY (the user, 2026-09-29). The Job
  // Portal is candidate INTAKE, not a module and not a Requirements tab:
  //   Candidates & Pipeline → Job Portal Candidates → Send to ATS → Pipeline
  // Publishing stays on each requirement ("Posted on"), and the portal sync
  // status / logs live under Administration → Integrations → Job Portal.
  // Jobs / Requirements itself has no tab strip any more.
  // CLIENTS IS IN ONE PLACE — HERE (clients role spec 2026-09-29). It is no
  // longer a tab of Jobs / Requirements. Admin, Management and BDE ("My
  // Clients") ✅; a TL 👁 (their team's clients, limited); Accounts 👁 (the
  // billing view); a Recruiter never — they hold no Client List view, so the
  // entry is hidden and GET /api/clients answers 403.
  leaf('🏢', '/clients', 'Clients', [['clients', 'Client List', 'view']]),
  leaf('👥', '/candidates', 'Candidates & Pipeline', [['candidates', 'Candidate List', 'view']]),
  leaf('🎯', '/ats/team', 'Recruiter & BDE', [['recruiterbde', 'Team View', 'view']]),
  leaf('📅', '/ats/calendar', 'Interview Calendar', [['interviews', 'Calendar View', 'view']]),
  // NO "Reports" ENTRY HERE (the user, 2026-09-29: "Move the ATS Reports into
  // the overall Reports module"). ATS Reports is listed once, in the Reports
  // group beside Job Portal Reports and Accounts Reports — same page, same
  // permission (reports / ATS Reports / view), so everyone who reached it
  // from ATS reaches it from Reports.
  // NO "Internal Hiring" ENTRY (the user's rule, 2026-09-29: "In ATS, Internal
  // Hiring must NOT be a separate module"). Internal hiring runs INSIDE the
  // normal modules: Jobs / Requirements has a Client | Internal split
  // (/requirements?type=internal), Candidates & Pipeline the same filter, and
  // an internal application's pipeline reads HR Review → Dept Head / TL →
  // Interview → Feedback → Selected → Offer → Joining → HRMS. The old
  // /ats/internal-hiring URL redirects to /requirements?type=internal. HR's
  // ATS menu is therefore Dashboard · Jobs / Requirements · Candidates &
  // Pipeline · Interview Calendar, all server-scoped to internal openings.
];

// Review #3 §1 — nothing below is a menu entry, anywhere: they are tabs,
// stages, filters or action views INSIDE the seven pages above, still routed
// (a bookmark or a link from a page keeps working) but never listed.
export const UNLISTED_ATS_VIEWS = [
  'Screening', 'Follow-ups', 'Offers', 'Rejected', 'Joining', 'Applications', 'Sourcing',
  'Candidate Review', 'Client Review',
];

export const ACCOUNTS_ITEMS = [
  leaf('📊', '/accounts/dashboard', 'Dashboard', [['accounts', 'Accounts Dashboard', 'view']], 'accounts'),
  leaf('🏢', '/office', 'Office / Business', [['accounts', 'Office & Expenses', 'view']]),
  leaf('🧾', '/invoices', 'Invoices', [['accounts', 'Invoices', 'view']]),
  leaf('🏦', '/bank', 'Bank & Reconciliation', [['accounts', 'Bank & Reconciliation', 'view']]),
  // SPEC B: the payroll journal, the ledger and the payroll reconciliation.
  leaf('📒', '/accounts/journal', 'Journal & Ledger', [['accounts', 'Journal & Ledger', 'view']]),
  // Signed client agreements, read-only for the accounts desk (routes/agreementSeal.js).
  leaf('📝', '/accounts/agreements', 'Client Agreements', [['accounts', 'Invoices', 'view']], 'accounts'),
];

// ADMINISTRATION — §15, exactly.
//
//   Super Admin / Admin      the whole group
//   Manager / Asst Manager   Profile, Notifications, and — IF CONFIGURED in
//                            Role Catalog — read-only Organization Structure
//                            and Audit Logs
//   everyone else            Profile and Notifications, nothing more
//
// Two things changed to make that true.
//
//   * Profile and Notifications are EVERYONE'S (§15), so they carry no perms.
//     They were gated on `administration / Users / view`, i.e. Super Admin and
//     Admin, which meant every other login had no Profile entry at all.
//     External logins still reach only these two — nav.js mayRenderSection()
//     lists both in ALWAYS_OPEN_PATHS and refuses the rest of /admin — and the
//     group is labelled "Settings" for them, never "Administration".
//
//   * Employee Management now names an ADMINISTRATION permission. It used to
//     name the HRMS one so a TL could still reach their department's people,
//     which — once the screen moved under Administration — gave a TL an
//     "Administration" group containing that single entry. §15 says that is
//     wrong. The TL's access did not go away: it moved to where the matrix
//     puts it, HRMS -> Employees, pointing at the same scoped screen.
export const ADMIN_ITEMS = [
  leaf('🏢', '/admin/company', 'Company Setup', [['administration', 'Company Setup', 'view']]),
  leaf('🗂️', '/admin/departments', 'Departments & Teams', [['administration', 'Departments & Teams', 'view']]),
  leaf('💺', '/admin/positions', 'Positions & Seat History', [['administration', 'Departments & Teams', 'view']]),
  leaf('👥', '/employees', 'Employee Management', [['administration', 'Users', 'view']]),
  leaf('👤', '/admin/users', 'Users', [['administration', 'Users', 'view']]),
  // Super Admin only, and not while already viewing as (components/ViewAs.jsx).
  { ...leaf('👁', '/admin/view-as', 'View as', null), when: (u) => !!u && u.role === 'SUPER_ADMIN' && !u.viewAs },
  leaf('🔐', '/admin/roles', 'Role Catalog', [['administration', 'Role Catalog', 'view']]),
  leaf('🔌', '/admin/integrations', 'Integrations', [['administration', 'Integrations', 'view']]),
  leaf('🏗️', '/admin/org-structure', 'Organization Structure', [['administration', 'Organization Structure', 'view']]),
  leaf('📜', '/admin/audit', 'Audit Logs', [['administration', 'Audit Logs', 'view']]),
  leaf('🔔', '/admin/notifications', 'Notifications', null),
  leaf('👤', '/admin/profile', 'Profile', null),
];

export const REPORTS_ITEMS = [
  // ONE entry for all of ATS Reports: the eleven reports (Recruitment,
  // Requirements, … SLA & Aging) are tabs inside the page, never sidebar
  // entries of their own.
  // ATS Reports lives HERE and only here (2026-09-29 — moved out of the ATS
  // menu into the overall Reports module).
  // Product-gated (user, 2026-09-29): an R&D employee or anyone without ATS
  // must not see ATS / Job Portal reports, whatever their HRMS role grants.
  leaf('🎯', '/reports/ats', 'ATS Reports', [['reports', 'ATS Reports', 'view']], 'ats'),
  leaf('🌐', '/reports/job-portal', 'Job Portal Reports', [['reports', 'Job Portal Reports', 'view']], 'ats'),
  leaf('💰', '/reports/accounts', 'Accounts Reports', [['reports', 'Accounts Reports', 'view']], 'accounts'),
];

function leafVisible(user, item) {
  if (item.product && !(user?.products || {})[item.product]) return false;
  const held = ([m, f, a]) => (f ? can(user, null, m, f, a) : canModule(user, m));
  if (item.unless && item.unless.every(held)) return false;
  if (item.when && !item.when(user)) return false;
  if (!item.perms) return true;                       // Notifications, Profile
  return item.perms.every(held);
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

// Review #2 §13 — a Recruiter (and a BDE — both see only their own row) does
// NOT get the Recruiter & BDE management page: the same entry reads "My Work"
// and the route shows their own work summary (pages/ats/Team.jsx). The
// server scopes /ats/team to them either way.
// The ATS role whose SCOPE this login has (a custom role borrows a system
// role's scope — identity.js scopeRoles), falling back to the product role.
export function atsRoleOf(user) {
  return (user && user.scopeRoles && user.scopeRoles.ats) || productRole(user, 'ats');
}

// Review #3 §15 / §28 — "My Work everywhere". SAME routes, SAME permissions;
// only the words change, so a recruiter reads the menu as their own work:
//   Recruiter  My Work · My Requirements · My Candidates · My Workload ·
//              My Interviews · Reports
//   BDE        My Work · Jobs / Requirements · My Clients · Candidates &
//              Pipeline · My Workload · Interview Calendar · Reports
//   TL         My Team (dashboard) · … · Team Workload (Recruiter & BDE) — one
//              "My Team" entry, not two with the same name
// Manager / Asst Manager / STL / Super Admin keep the module names.
const ROLE_LABELS = {
  RECRUITER: {
    '/ats/dashboard': 'My Work', '/requirements': 'My Requirements', '/candidates': 'My Candidates',
    '/ats/team': 'My Workload', '/ats/calendar': 'My Interviews',
  },
  BDE: { '/ats/dashboard': 'My Work', '/clients': 'My Clients', '/ats/team': 'My Workload' },
  // The module keeps its name "Recruiter & BDE" for a TL (user spec
  // 2026-09-29) — TL review / workload lives inside it as filters.
  TL: { '/ats/dashboard': 'My Team' },
};
const ROLE_ICONS = { '/ats/team': { RECRUITER: '🗂️', BDE: '🗂️' } };
// User notes #4 — a Client or a Candidate login gets ONE entry: its own
// portal (pages/portal/*). The internal ATS screens stay reachable only by
// typing their address, and the API still scopes every one of them.
const PORTAL_ITEMS = {
  CLIENT: [leaf('🏢', '/client-portal', 'My Portal', [['requirements', 'Client Job Portal', 'view']])],
  CANDIDATE: [leaf('🗂️', '/my-applications', 'My Applications', [['candidates', 'Candidate List', 'view']])],
};
// ACCOUNTS IN ATS is a billing view and nothing else (role specs 2026-09-29):
// Jobs / Requirements (the requirements with joined candidates) and Clients
// (the billing view). No ATS dashboard, candidates, team or calendar entry.
const ACCOUNTS_ATS_PATHS = ['/requirements', '/clients'];
export function atsItemsFor(user) {
  const role = atsRoleOf(user);
  if (PORTAL_ITEMS[role]) return PORTAL_ITEMS[role];
  if (role === 'ACCOUNTANT') return ATS_ITEMS.filter((i) => ACCOUNTS_ATS_PATHS.includes(i.to));
  const labels = ROLE_LABELS[role];
  if (!labels) return ATS_ITEMS;
  return ATS_ITEMS.map((i) => (labels[i.to]
    ? { ...i, label: labels[i.to], ...((ROLE_ICONS[i.to] || {})[role] ? { icon: ROLE_ICONS[i.to][role] } : {}) }
    : i));
}

// Group render order is the prototype's: HRMS, ATS, Accounts, Reports,
// Administration. Which groups and which items appear is decided entirely by
// the permission matrix.
export function groupsForUser(user) {
  const groups = [];
  const add = (id, label, items) => {
    const shown = visibleItems(user, items);
    if (shown.length) groups.push([id, label, shown, SECTION_ICON[id]]);
  };
  // Labels come from sectionLabel(), so an external login can never be shown
  // an internal product name in the sidebar.
  add('hrms', sectionLabel('hrms', user), HRMS_ITEMS);
  add('ats', sectionLabel('ats', user), atsItemsFor(user));
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
  // /employees is the employee list. It is an HRMS screen for the leads who
  // reach it from HRMS -> Employees, and the same screen for an admin who
  // reaches it from Administration -> Employee Management; putting it in the
  // HRMS section keeps a TL's sidebar from opening an Administration group
  // they hold nothing else in.
  [/^\/(hrms|attendance|leave|payroll|performance|employee-services|my-profile|employees)/, 'hrms'],
  [/^\/(ats|requirements|clients|candidates|client-portal|agreements)/, 'ats'],
  // ATS Reports is in the Reports group (2026-09-29) — /reports/* below.
  [/^\/(accounts|invoices|bank|office)/, 'accounts'],
  [/^\/reports/, 'reports'],
  [/^\/admin/, 'admin'],
];
// THE EMPLOYEE LIST BELONGS TO WHICHEVER ENTRY THE USER ACTUALLY HAS.
//
// Both HRMS -> Employees and Administration -> Employee Management point at
// /employees, and the two are never both visible: the HRMS leaf carries
// `unless: administration/Users/view`, so anyone holding that permission sees
// only the Administration entry. That permission is therefore exactly the
// test for which section the screen is being opened from. Without it the
// table above sent every visitor to HRMS, so an admin clicking Employee
// Management watched the sidebar jump to HRMS and the Administration group
// collapse under them.
//
// `user` is optional: with no user the table answers, which is the old
// behaviour, so every existing caller keeps working.
const isEmployeePath = (p) => p === '/employees' || p.startsWith('/employees/');

export function sectionOf(pathname, user) {
  if (user && isEmployeePath(pathname)) {
    return can(user, null, 'administration', 'Users', 'view') ? 'admin' : 'hrms';
  }
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
