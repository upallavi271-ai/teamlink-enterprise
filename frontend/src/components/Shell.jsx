import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { workRoleLabel } from '../permissions';
import {
  sectionLabel, mayRenderSection, groupsForUser, flattenGroups, sectionOf, scoreMatch,
  SECTION_ICON, SETUP_TABS, INTERVIEW_TABS, moduleTabLabel, isExternalUser,
} from '../nav';
import ModuleTabs from './ModuleTabs.jsx';
import Logo from './Logo.jsx';
import AiAssistant, { AiStatusDot } from './AiAssistant.jsx';
import ProfileStatusBanner from './ProfileStatusBanner.jsx';
import SetupTabs from './SetupTabs.jsx';
import InterviewTabs from './InterviewTabs.jsx';
import NotificationBell from './NotificationBell.jsx';
import TaskPopup from './dashboard/TaskPopup.jsx';
import JobRequestPopup from './JobRequestPopup.jsx';
import HealthDot from './dashboard/HealthDot.jsx';
import TodayTasks from './dashboard/TodayTasks.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import { loadClientAliases, forgetClientAliases } from './clientAliases.js';
import { hasAtsWork } from '../utils/useAtsAlerts';
import { useJobPortalUrl } from '../pages/JobPortalRedirect.jsx';
import { canOpenJobPortalStaff } from '../pages/JobPortalLaunch.jsx';
import { useOmniEntry } from './outreach/useOmniChildren.js';
import OmniTopChips from './omni/OmniTopChips.jsx';
import './ShellPhone.css';
import AiCallOfferHost from './aicalling/AiCallOfferHost.jsx'; // "Tell them with the AI assistant?" after a Shortlisted move / an interview booking
import './MobileNav.css';

// The sidebar Omni-Channel opens TeamLink's own /green-start page in a NEW TAB (2026-10-29): Green Start over the whole window, already signed in.
// That page asks TeamLink for the door pass (POST /api/omni-gs/session) and the sign-in ticket by itself (components/outreach/GreenStart.jsx).
import useMobileDrawer, { useMediaQuery, PHONE_MQ } from './useMobileDrawer.js';

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

// A sidebar row is a <div> with a click handler; this makes it work from the
// keyboard too (Tab to it, Enter or Space to press it) and tells a screen
// reader what it is.
function press(fn, role = 'button') {
  return {
    role,
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    },
  };
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
  // The phone menu: a slide-in drawer under 900px (./useMobileDrawer.js).
  const drawer = useMobileDrawer(pathname + search);
  const open = drawer.open;
  const isPhone = useMediaQuery(PHONE_MQ);
  // Old client names (ClientAlias) for every type-to-search box: loaded once per sign-in, refreshed when the tab comes back.
  // They are for matching only; boxes keep showing the official name.
  useEffect(() => {
    if (!user) { forgetClientAliases(); return undefined; }
    loadClientAliases({ force: true });
    const again = () => { if (document.visibilityState === 'visible') loadClientAliases(); };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, [user && user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [manual, setManual] = useState({});          // prototype's sidebarManualToggle
  const [manualSub, setManualSub] = useState({});    // the ATS sub-sections

  const baseGroups = useMemo(() => groupsForUser(user), [user]);
  // OMNI-CHANNEL (founder, 2026-10-17): opens like ATS: a group whose children are the hubs this login may open (from /api/outreach/me).
  // The same group row, arrow, icons and active highlight as every other group; the page itself then shows only the sub-tabs of the open hub.
  // 2026-10-21: for the logins that may open the founder's Green Start product, Omni-Channel is ONE sidebar entry that opens it (below Administration,
  // above Job Portal (public)). The other logins (BDE, BDE TL, Recruiter, Marketing, Finance) keep the group with the native pages.
  const { kids: omniKids, greenStart: omniGreenStart } = useOmniEntry(user);
  const groups = useMemo(() => (omniKids && omniKids.length && !omniGreenStart ? [...baseGroups, ['omni', 'Omni-Channel', omniKids, '📣']] : baseGroups), [baseGroups, omniKids, omniGreenStart]);
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
  function closeSidebar() { drawer.close(); }

  const isActive = (to) => !!(current && current.to === to);
  const currentPath = current ? current.to.split('?')[0] : null;

  return (
    <div className="app-shell">
      <aside
        className={'sidebar' + (open ? ' open' : '')}
        id="sidebar"
        ref={drawer.drawerRef}
        {...(drawer.isMobile ? {
          role: 'dialog',
          'aria-label': 'Main menu',
          'aria-modal': open ? 'true' : undefined,
          'aria-hidden': open ? undefined : 'true',
          inert: open ? undefined : '',
        } : {})}
        {...drawer.touch}
      >
        <div className="sidebar-brand">
          <Link to="/" onClick={closeSidebar} aria-label="TeamLink Consultants — home">
            <Logo />
          </Link>
          <button type="button" className="sidebar-close" ref={drawer.closeRef} onClick={closeSidebar} aria-label="Close menu">✕</button>
        </div>
        {/* Search moves in here on a phone, where the top bar has no room for it. */}
        {isPhone && hasAtsWork(user) && <div className="sidebar-search"><GlobalSearch /></div>}
        <nav className="sidebar-nav" aria-label="Sections">
          <div
            className={'sb-item' + (section === 'dashboard' ? ' top-active' : '')}
            {...press(() => navTo('/'), 'link')}
            aria-current={section === 'dashboard' ? 'page' : undefined}
          >
            <Ico char={SECTION_ICON.dashboard} />Dashboard
          </div>
          {groups.map(([s, label, items, icon]) => (
            <div className={'sb-group' + (isGroupOpen(s) ? ' open' : '')} key={s}>
              <div className="sb-group-head" {...press(() => toggleGroup(s, items))} aria-expanded={isGroupOpen(s)}>
                <span className="sb-group-label"><Ico char={icon} />{label}</span>
                <span className="chev" aria-hidden="true">▸</span>
              </div>
              <div className="sb-sub">
                {items.map((item) => (item.children ? (
                  <div className={'sb-sub-group' + (isSubOpen(item.id) ? ' open' : '')} key={item.id}>
                    <div className="sb-sub-head" {...press(() => toggleSub(item.id))} aria-expanded={isSubOpen(item.id)}>
                      <span className="sb-group-label"><Ico char={item.icon} />{item.label}</span>
                      <span className="chev" aria-hidden="true">▸</span>
                    </div>
                    <div className="sb-leaf-list">
                      {item.children.map((c) => (
                        <div
                          key={c.to}
                          className={'sb-leaf' + (isActive(c.to) ? ' active' : '')}
                          {...press(() => navTo(c.to), 'link')}
                          aria-current={isActive(c.to) ? 'page' : undefined}
                        >
                          <Ico char={c.icon} />{c.label}{c.badge ? <span className="count" style={{ marginLeft: 'auto', background: '#1d9b5a', color: '#fff', borderRadius: 999, fontSize: 10, padding: '1px 7px' }}>{c.badge}</span> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div
                    key={item.to}
                    className={'sb-sub-item' + (isActive(item.to) ? ' active' : '')}
                    {...press(() => navTo(item.to), 'link')}
                    aria-current={isActive(item.to) ? 'page' : undefined}
                  >
                    <Ico char={item.icon} />{item.label}{item.badge ? <span className="count" style={{ marginLeft: 'auto', background: '#1d9b5a', color: '#fff', borderRadius: 999, fontSize: 10, padding: '1px 7px' }}>{item.badge}</span> : null}
                  </div>
                )))}
              </div>
            </div>
          ))}
          {omniKids && omniKids.length > 0 && omniGreenStart && (
            <div className="sb-group">
              {/* Founder, 2026-10-21: Omni-Channel opens the Green Start product in a separate tab. */}
              {/* 2026-10-29 (founder: "full page open avali pakkana side bar full page open avali logins adakunda"): live AND on the PC it opens
                  /green-start in a new tab - Green Start alone over the whole window, with its own sidebar, already signed in. The TeamLink page with
                  Manage / Help (start, stop, backup, logs) is still at /omni-channel. */}
              <a className="sb-item" href="/green-start" target="_blank" rel="noopener noreferrer" title="Opens Green Start full page in a new tab, already signed in">
                <Ico char="📣" />Omni-Channel ↗
              </a>
            </div>
          )}
          {/* Only for logins with ATS (user, 2026-09-29: R&D / non-ATS staff have
              nothing to do with the job portal). */}
          {user?.products?.ats && !isExternalUser(user) && (
            <div className="sb-group">
              {/* 2026-10-29: Admins, Recruiters and TLs open the Job Portal already signed in with this login (no second login);
                  everyone else gets the public portal. */}
              {canOpenJobPortalStaff(user) ? (
                <a className="sb-item" href="/sso/job-portal" target="_blank" rel="noreferrer" title="Opens the Job Portal in a new tab, already signed in">
                  <Ico char="🌐" />Job Portal ↗
                </a>
              ) : (
                <a className="sb-item" href={`${jobPortalUrl}/`} target="_blank" rel="noreferrer">
                  <Ico char="🌐" />Job Portal (public) ↗
                </a>
              )}
            </div>
          )}
        </nav>
        {/* Who is signed in, and Sign out — on a phone the top bar has no room for the button. */}
        <div className="sidebar-user">
          <div className="avatar" aria-hidden="true">{initials(user?.name)}</div>
          <div className="su-who">
            <b>{user?.name}</b>
            <span>{workRoleLabel(user, ['hrms', 'ats', 'accounts'].includes(section) ? section : undefined)}</span>
          </div>
          <button type="button" className="btn btn-sm" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <div className={'sidebar-overlay' + (open ? ' show' : '')} onClick={closeSidebar} aria-hidden="true" />

      <div className="content-col">
        <div className="topbar">
          <button
            type="button"
            className="hamburger"
            ref={drawer.toggleRef}
            onClick={drawer.openDrawer}
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="sidebar"
          >
            <span className="hb-ico" aria-hidden="true">☰</span>
            <span className="hb-label">Menu</span>
          </button>
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
            {section === 'omni' && pathname.startsWith('/omni-channel-native') && <OmniTopChips />}
            <NotificationBell />
            {/* The login popup: 'You have 6 tasks, 2 are late' (spec §14). */}
            {hasAtsWork(user) && <TaskPopup />}
            {/* A client's new job request: the client's BDE and the BDE TL see it on screen at once (2026-10-09). */}
            {hasAtsWork(user) && <JobRequestPopup />}
            {/* Admin health dot: system problems only (dashboard review #2). */}
            {hasAtsWork(user) && <HealthDot />}
            <div className="avatar">{initials(user?.name)}</div>
            <button className="btn btn-ghost btn-sm tb-signout" onClick={logout}>Sign Out</button>
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
          <AiCallOfferHost />
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
