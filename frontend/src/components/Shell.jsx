import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { can, canModule, workRoleLabel } from '../permissions';

// ---------------------------------------------------------------------------
// Nav structure is the prototype's, verbatim: SECTION_LABEL (line 2065) and
// SUBNAV (line 2176) from teamlink-enterprise_69.html. Only the `to` paths are
// this app's React Router paths — labels, grouping and ordering are the
// prototype's. Entries marked `extra` are screens this app has that the
// prototype's nav lacks; they are appended to the group they belong to rather
// than orphaned.
// ---------------------------------------------------------------------------
const SECTION_LABEL = {
  dashboard: 'Dashboard', hrms: 'HRMS', ats: 'ATS',
  accounts: 'Accounts', admin: 'Administration', reports: 'Reports',
};

// Every nav item now names the (module, feature) it belongs to, and the
// sidebar renders it only when the permission engine says the signed-in user
// can view that feature. This is the SAME matrix the API enforces — the nav is
// not a separate permission system, and hiding an item is never the control.
const HRMS_ITEMS = [
  ['/hrms', 'HRMS Dashboard', 'hrms', 'HRMS Dashboard'],
  ['/my-profile', 'My Profile', 'hrms', null],
  ['/attendance', 'Attendance & Time', 'hrms', 'Attendance & Time'],
  ['/leave', 'Leave & Holidays', 'hrms', 'Leave & Holidays'],
  ['/payroll', 'Payroll & Compensation', 'hrms', null],
  ['/performance', 'Performance & Development', 'hrms', 'Performance & Development'],
  ['/employee-services', 'Employee Services', 'hrms', 'Employee Services'],
];

const ATS_ITEMS = [
  // The ATS dashboard is a dashboard-module screen, but it belongs in the nav
  // only for a login that actually has the ATS product.
  ['/ats/dashboard', 'Dashboard', 'dashboard', 'KPI Overview', 'ats'],
  ['/requirements', 'Jobs / Requirements', 'requirements', 'Requirement List'],
  ['/clients', 'Clients', 'clients', 'Client List'],
  ['/candidates', 'Candidates & Pipeline', 'candidates', 'Candidate List'],
  ['/ats/team', 'Recruiter & BDE', 'recruiterbde', 'Team View'],
  ['/ats/calendar', 'Interview Calendar', 'interviews', 'Calendar View'],
];

const ACCOUNTS_ITEMS = [
  ['/accounts/dashboard', 'Dashboard', 'accounts', 'Accounts Dashboard', 'accounts'],
  ['/office', 'Office / Business', 'accounts', 'Office & Expenses'],
  ['/invoices', 'Invoices', 'accounts', 'Invoices'],
  ['/bank', 'Bank & Reconciliation', 'accounts', 'Bank & Reconciliation'],
];

const ADMIN_ITEMS = [
  ['/admin/company', 'Company Setup', 'administration', 'Company Setup'],
  ['/admin/departments', 'Departments & Teams', 'administration', 'Departments & Teams'],
  // Employee Management is an HRMS feature the Administration group links to,
  // so HR roles reach it without being given the Administration module.
  ['/employees', 'Employee Management', 'hrms', 'Employee Management'],
  ['/admin/users', 'Users', 'administration', 'Users'],
  ['/admin/roles', 'Role Catalog', 'administration', 'Role Catalog'],
  ['/admin/integrations', 'Integrations', 'administration', 'Integrations'],
  ['/admin/org-structure', 'Organization Structure', 'administration', 'Organization Structure'],
  // Notifications and Profile are everyone's, whatever their role.
  ['/admin/notifications', 'Notifications', null, null],
  ['/admin/audit', 'Audit Logs', 'administration', 'Audit Logs'],
  ['/admin/profile', 'Profile', null, null],
];

const REPORTS_ITEMS = [
  ['/reports/ats', 'ATS Reports', 'reports', 'ATS Reports'],
  ['/reports/job-portal', 'Job Portal Reports', 'reports', 'Job Portal Reports'],
  ['/reports/accounts', 'Accounts Reports', 'reports', 'Accounts Reports'],
];

// Group render order is the prototype's sidebarHtml() order (line 2100):
// HRMS, ATS, Accounts, Reports, Administration. Which groups and which items
// appear is decided entirely by the permission matrix.
function visibleItems(user, items) {
  return items.filter(([, , moduleId, feature, product]) => {
    if (product && !(user?.products || {})[product]) return false;
    if (!moduleId) return true;              // Notifications, Profile, My Profile
    if (!feature) return canModule(user, moduleId);
    return can(user, null, moduleId, feature, 'view');
  });
}

function groupsForUser(user) {
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

// Which sidebar section a URL belongs to, so the group opens and the topbar
// title / breadcrumb name the right section.
const SECTION_OF_PATH = [
  [/^\/(hrms|attendance|leave|payroll|performance|employee-services|my-profile)/, 'hrms'],
  [/^\/(ats|requirements|clients|candidates)/, 'ats'],
  [/^\/(accounts|invoices|bank|office)/, 'accounts'],
  [/^\/reports/, 'reports'],
  [/^\/(admin|employees)/, 'admin'],
];
function sectionOf(pathname) {
  const hit = SECTION_OF_PATH.find(([re]) => re.test(pathname));
  return hit ? hit[1] : 'dashboard';
}

function initials(name) {
  if (!name) return '?';
  return name.replace(/\(.*\)/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export default function Shell() {
  const { user, logout, switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);           // mobile sidebar
  const [manual, setManual] = useState({});          // prototype's sidebarManualToggle
  const [unread, setUnread] = useState(0);

  const groups = useMemo(() => groupsForUser(user), [user]);
  const section = sectionOf(pathname);

  useEffect(() => {
    api.get('/admin/notifications')
      .then((res) => setUnread(res.data.filter((n) => !n.read).length))
      .catch(() => setUnread(0));
  }, [pathname]);

  // isGroupOpen (prototype line 2067): the current section's group is open
  // unless the user has toggled it by hand.
  const isGroupOpen = (s) => (s in manual ? manual[s] : section === s);

  function toggleGroup(s, firstPath) {
    if (section === s) {
      setManual({ ...manual, [s]: !isGroupOpen(s) });
    } else {
      setManual({});
      closeSidebar();
      navigate(firstPath);
    }
  }
  function navTo(path) { closeSidebar(); navigate(path); }
  function closeSidebar() { setOpen(false); }

  function onSearch(e) {
    e.preventDefault();
    if (!q.trim()) return;
    navigate(`/ats/search?q=${encodeURIComponent(q)}`);
  }

  // Breadcrumb: section, then the nav item whose path this page sits under.
  const allItems = groups.flatMap(([, , items]) => items);
  const current = allItems
    .filter(([to]) => pathname === to || pathname.startsWith(to + '/'))
    .sort((a, b) => b[0].length - a[0].length)[0];

  return (
    <div className="app-shell">
      <aside className={'sidebar' + (open ? ' open' : '')} id="sidebar">
        <div className="sidebar-brand">
          <div>
            <div className="b1">TeamLink Consultants</div>
            <div className="b2">TeamLink.Enterprise</div>
          </div>
          <button className="sidebar-close" onClick={closeSidebar} aria-label="Close menu">✕</button>
        </div>
        <nav className="sidebar-nav">
          <div
            className={'sb-item' + (section === 'dashboard' ? ' top-active' : '')}
            onClick={() => navTo('/')}
          >
            Dashboard
          </div>
          {groups.map(([s, label, items]) => (
            <div className={'sb-group' + (isGroupOpen(s) ? ' open' : '')} key={s}>
              <div className="sb-group-head" onClick={() => toggleGroup(s, items[0][0])}>
                <span>{label}</span><span className="chev">▸</span>
              </div>
              <div className="sb-sub">
                {items.map(([to, l]) => (
                  <div
                    key={to}
                    className={'sb-sub-item' + (current && current[0] === to ? ' active' : '')}
                    onClick={() => navTo(to)}
                  >
                    {l}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="sb-group">
            <a className="sb-item" href="/careers" target="_blank" rel="noreferrer">Job Portal (public) ↗</a>
          </div>
        </nav>
      </aside>
      <div className={'sidebar-overlay' + (open ? ' show' : '')} onClick={closeSidebar} />

      <div className="content-col">
        <div className="topbar">
          <button className="hamburger" onClick={() => setOpen(true)} title="Menu">☰</button>
          <div className="topbar-title">{SECTION_LABEL[section] || 'Dashboard'}</div>
          <form className="gsearch" onSubmit={onSearch}>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search candidates, clients, requirements…"
            />
          </form>
          <div className="topbar-right">
            {(user?.workspaces || []).length > 1 && (
              <select
                className="rolechip"
                aria-label="Workspace"
                value={user.workspace}
                onChange={(e) => switchWorkspace(e.target.value).then((u) => navTo(u.landingPath))}
                style={{ padding: '2px 6px' }}
              >
                {user.workspaces.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
              </select>
            )}
            <span className="rolechip">{workRoleLabel(user)}</span>
            <span className="rolechip" style={{ cursor: 'pointer' }} onClick={() => navTo('/admin/notifications')}>🔔 {unread}</span>
            <div className="avatar">{initials(user?.name)}</div>
            <button className="btn btn-ghost btn-sm" onClick={logout}>Sign Out</button>
          </div>
        </div>

        <div className="breadcrumb">
          {section === 'dashboard' ? (
            <span className="bc-current">Dashboard</span>
          ) : (
            <>
              <span className="bc-current">{SECTION_LABEL[section]}</span>
              {current && (
                <>
                  <span className="bc-sep">/</span>
                  {pathname === current[0]
                    ? <span className="bc-current">{current[1]}</span>
                    : <Link className="bc-link" to={current[0]}>{current[1]}</Link>}
                </>
              )}
              {current && pathname !== current[0] && (
                <>
                  <span className="bc-sep">/</span>
                  <span className="bc-current">{decodeURIComponent(pathname.slice(current[0].length + 1))}</span>
                </>
              )}
            </>
          )}
        </div>

        <main>
          <Outlet />
        </main>

        <footer>
          TeamLink.Enterprise — HRMS + ATS + Accounts in one login · connected to the TeamLink Job Portal
        </footer>
      </div>
    </div>
  );
}
