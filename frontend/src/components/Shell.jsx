import { useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { workRoleLabel } from '../permissions';
import {
  sectionLabel, mayRenderSection, groupsForUser, flattenGroups, sectionOf, scoreMatch,
  SECTION_ICON, SETUP_TABS, INTERVIEW_TABS, moduleTabLabel,
} from '../nav';
import ModuleTabs from './ModuleTabs.jsx';
import Logo from './Logo.jsx';
import AiAssistant, { AiStatusDot } from './AiAssistant.jsx';
import ProfileStatusBanner from './ProfileStatusBanner.jsx';
import SetupTabs from './SetupTabs.jsx';
import InterviewTabs from './InterviewTabs.jsx';
import NotificationBell from './NotificationBell.jsx';
import TaskPopup from './dashboard/TaskPopup.jsx';
import HealthDot from './dashboard/HealthDot.jsx';
import TodayTasks from './dashboard/TodayTasks.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import { hasAtsWork } from '../utils/useAtsAlerts';
import { useJobPortalUrl } from '../pages/JobPortalRedirect.jsx';
import './ShellPhone.css';

// The sidebar renders the tree in ../nav.js. Which groups, which sections and
// which tabs appear is decided entirely by the permission engine — see that
// file's header.
//
// Each entry also carries an icon (nav.js, §19). It is rendered in its own
// fixed-width column, aria-hidden, so the labels still line up and a screen
// reader reads the label alone.

function Ico({ char }) {
  return <span className="sb-ico" aria-hidden="true">{char || ''}</span>;
}

function initials(name) {
  if (!name) return '?';
  return name.replace(/\(.*\)/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export default function Shell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  // The TeamLink Job Portal is its own application; its URL is JOB_PORTAL_URL
  // on the server (GET /api/public/job-portal/config).
  const jobPortalUrl = useJobPortalUrl();
  const [open, setOpen] = useState(false);           // mobile sidebar
  const [manual, setManual] = useState({});          // prototype's sidebarManualToggle
  const [manualSub, setManualSub] = useState({});    // the ATS sub-sections

  const groups = useMemo(() => groupsForUser(user), [user]);
  const section = sectionOf(pathname, user);
  // The 🔔 count and its dropdown live in ./NotificationBell.jsx (§33).

  // The nav entry the current URL belongs to — the highest-scoring match.
  const allLeaves = useMemo(() => flattenGroups(groups), [groups]);
  const current = useMemo(() => {
    let best = null;
    let bestScore = 0;
    allLeaves.forEach((item) => {
      const sc = scoreMatch(item.to, pathname, search);
      if (sc > bestScore) { bestScore = sc; best = item; }
    });
    return best;
  }, [allLeaves, pathname, search]);

  // isGroupOpen (prototype line 2067): the current section's group is open
  // unless the user has toggled it by hand. The ATS sub-sections behave the
  // same way one level down.
  const isGroupOpen = (s) => (s in manual ? manual[s] : section === s);
  const isSubOpen = (id) => (id in manualSub
    ? manualSub[id]
    : !!(current && current.parent && current.parent.id === id));

  function firstPathOf(items) {
    const head = items[0];
    return head.children ? head.children[0].to : head.to;
  }

  function toggleGroup(s, items) {
    if (section === s) {
      setManual({ ...manual, [s]: !isGroupOpen(s) });
    } else {
      setManual({});
      setManualSub({});
      closeSidebar();
      navigate(firstPathOf(items));
    }
  }
  function toggleSub(id) { setManualSub({ ...manualSub, [id]: !isSubOpen(id) }); }
  function navTo(path) { closeSidebar(); navigate(path); }
  function closeSidebar() { setOpen(false); }

  const isActive = (to) => !!(current && current.to === to);
  const currentPath = current ? current.to.split('?')[0] : null;

  return (
    <div className="app-shell">
      <aside className={'sidebar' + (open ? ' open' : '')} id="sidebar">
        <div className="sidebar-brand">
          <Link to="/" onClick={closeSidebar} aria-label="TeamLink Consultants — home">
            <Logo />
          </Link>
          <button className="sidebar-close" onClick={closeSidebar} aria-label="Close menu">✕</button>
        </div>
        <nav className="sidebar-nav">
          <div
            className={'sb-item' + (section === 'dashboard' ? ' top-active' : '')}
            onClick={() => navTo('/')}
          >
            <Ico char={SECTION_ICON.dashboard} />Dashboard
          </div>
          {groups.map(([s, label, items, icon]) => (
            <div className={'sb-group' + (isGroupOpen(s) ? ' open' : '')} key={s}>
              <div className="sb-group-head" onClick={() => toggleGroup(s, items)}>
                <span className="sb-group-label"><Ico char={icon} />{label}</span>
                <span className="chev">▸</span>
              </div>
              <div className="sb-sub">
                {items.map((item) => (item.children ? (
                  <div className={'sb-sub-group' + (isSubOpen(item.id) ? ' open' : '')} key={item.id}>
                    <div className="sb-sub-head" onClick={() => toggleSub(item.id)}>
                      <span className="sb-group-label"><Ico char={item.icon} />{item.label}</span>
                      <span className="chev">▸</span>
                    </div>
                    <div className="sb-leaf-list">
                      {item.children.map((c) => (
                        <div
                          key={c.to}
                          className={'sb-leaf' + (isActive(c.to) ? ' active' : '')}
                          onClick={() => navTo(c.to)}
                        >
                          <Ico char={c.icon} />{c.label}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div
                    key={item.to}
                    className={'sb-sub-item' + (isActive(item.to) ? ' active' : '')}
                    onClick={() => navTo(item.to)}
                  >
                    <Ico char={item.icon} />{item.label}
                  </div>
                )))}
              </div>
            </div>
          ))}
          {/* Single sign-on to the Job Portal: Recruiter and Admin only (the
              server decides — user.jobPortal from /auth/me). Same tab. */}
          {user?.jobPortal?.allowed && (
            <div
              className="sb-item"
              onClick={() => navTo('/sso/job-portal')}
            >
              <Ico char="💼" />Job Portal
            </div>
          )}
          {/* Only for logins with ATS (user, 2026-09-29: R&D / non-ATS staff have
              nothing to do with the job portal). */}
          {user?.products?.ats && (
            <div className="sb-group">
              <a className="sb-item" href={`${jobPortalUrl}/`} target="_blank" rel="noreferrer">
                <Ico char="🌐" />Job Portal (public) ↗
              </a>
            </div>
          )}
        </nav>
      </aside>
      <div className={'sidebar-overlay' + (open ? ' show' : '')} onClick={closeSidebar} />

      <div className="content-col">
        <div className="topbar">
          <button className="hamburger" onClick={() => setOpen(true)} title="Menu">☰</button>
          <div className="topbar-title">{sectionLabel(section, user)}</div>
          {/* Review #3 §13 — "Search TeamLink": typed, grouped, scoped results
              (./GlobalSearch.jsx). The search API is part of ATS, so a login
              with no ATS work (plain Employee, Accounts) gets no box. */}
          {hasAtsWork(user) && <GlobalSearch />}
          <div className="topbar-right">
            {/* No workspace switcher: the sidebar already reaches every
                product, so the chip simply shows this login's role in the
                product whose page is open. */}
            <span className="rolechip tb-role">{workRoleLabel(user, ['hrms', 'ats', 'accounts'].includes(section) ? section : undefined)}</span>
            {/* Always-on AI status: green = model ready, amber = model not
                pulled, grey = offline. Opens the AI panel. */}
            <AiStatusDot />
            {/* Today's tasks (dashboard spec 2026-09-29): follow-ups, interviews and actions due today. */}
            <TodayTasks />
            <NotificationBell />
            {/* The login popup: 'You have 6 tasks, 2 are late' (spec §14). */}
            {hasAtsWork(user) && <TaskPopup />}
            {/* Admin health dot: system problems only (dashboard review #2). */}
            {hasAtsWork(user) && <HealthDot />}
            <div className="avatar">{initials(user?.name)}</div>
            <button className="btn btn-ghost btn-sm" onClick={logout}>Sign Out</button>
          </div>
        </div>

        <div className="breadcrumb">
          {section === 'dashboard' ? (
            <span className="bc-current">Dashboard</span>
          ) : (
            <>
              <span className="bc-current">{sectionLabel(section, user)}</span>
              {current && current.parent && (
                <>
                  <span className="bc-sep">/</span>
                  <span className="bc-current">{current.parent.label}</span>
                </>
              )}
              {current && (
                <>
                  <span className="bc-sep">/</span>
                  {pathname === currentPath
                    ? <span className="bc-current">{current.label}</span>
                    : <Link className="bc-link" to={current.to}>{current.label}</Link>}
                </>
              )}
              {current && pathname !== currentPath && moduleTabLabel(pathname) !== current.label && (
                <>
                  <span className="bc-sep">/</span>
                  <span className="bc-current">
                    {/* A Company Setup tab names itself (Master lists, Step timing …), not a URL piece. */}
                    {(SETUP_TABS.find((t) => t.to === pathname) || INTERVIEW_TABS.find((t) => t.to === pathname) || {}).label
                      || moduleTabLabel(pathname)
                      // A v3 module tab's detail page (/requirements/:id under
                      // Clients & Requirements): its own tab name, not a URL piece.
                      || (pathname.startsWith(`${currentPath}/`)
                        ? decodeURIComponent(pathname.slice(currentPath.length + 1))
                        : moduleTabLabel(`/${pathname.split('/')[1]}`) || 'Details')}
                  </span>
                </>
              )}
            </>
          )}
          {/* Review #3 §27 — whose data this is, on every ATS screen:
              "Scope: Education → Team A → My Team" / "Scope: All Company"
              (utils/scope.js scopeLabel, ATS reading, via /auth/me). */}
          {section === 'ats' && user && user.scope && (user.scope.atsLabel || user.scope.label) && (
            <span className="shell-scope" title="The records you can see on ATS screens">
              Your area: {user.scope.atsLabel || user.scope.label}
            </span>
          )}
        </div>

        <main>
          {/* FIRST LOGIN. Whatever workspace this person lands in, if their
              employee profile still needs them, they are told here. It
              renders nothing once the profile is with HR or approved, and
              nothing on the profile form itself — that page says it in
              place, and saying it twice on one screen reads as a bug. */}
          {/* HRMS pages only (user, 2026-10-03): opening ATS or Accounts must not
              greet the person with an HR form reminder. */}
          {section === 'hrms' && pathname !== '/my-profile' && <ProfileStatusBanner variant="shell" />}
          {/* An external login that types the URL of an internal screen gets a
              plain refusal rather than the screen's chrome — see
              mayRenderSection() in ../nav.js for why. */}
          <SetupTabs pathname={pathname} />
          <InterviewTabs pathname={pathname} />
          <ModuleTabs pathname={pathname} />
          {mayRenderSection(user, pathname) ? <Outlet /> : (
            <div className="card">
              <h1>Not available</h1>
              <div className="page-sub">This area is not part of your access.</div>
            </div>
          )}
        </main>

        {/* Review #2 §27 — small and unobtrusive: one faint line, no rule. */}
        <footer style={{ padding: '6px 22px 8px', fontSize: 10.5, borderTop: 0, opacity: 0.6 }}>
          {/* No product names: this footer renders for clients and candidates too. */}
          TeamLink.Enterprise · connected to the TeamLink Job Portal
        </footer>
      </div>

      {/* Floating, role-aware assistant (bottom right). */}
      <AiAssistant />
    </div>
  );
}
