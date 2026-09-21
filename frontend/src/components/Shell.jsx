import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { workRoleLabel } from '../permissions';
import {
  sectionLabel, mayRenderSection, groupsForUser, flattenGroups, sectionOf, scoreMatch,
} from '../nav';
import Logo from './Logo.jsx';
import AiAssistant from './AiAssistant.jsx';
import ProfileStatusBanner from './ProfileStatusBanner.jsx';
import Combo from './Combo.jsx';

// The sidebar renders the tree in ../nav.js. Which groups, which sections and
// which tabs appear is decided entirely by the permission engine — see that
// file's header.

function initials(name) {
  if (!name) return '?';
  return name.replace(/\(.*\)/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export default function Shell() {
  const { user, logout, switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);           // mobile sidebar
  const [manual, setManual] = useState({});          // prototype's sidebarManualToggle
  const [manualSub, setManualSub] = useState({});    // the ATS sub-sections
  const [unread, setUnread] = useState(0);

  const groups = useMemo(() => groupsForUser(user), [user]);
  const section = sectionOf(pathname);

  useEffect(() => {
    api.get('/admin/notifications')
      .then((res) => setUnread(res.data.filter((n) => !n.read).length))
      .catch(() => setUnread(0));
  }, [pathname]);

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

  function onSearch(e) {
    e.preventDefault();
    if (!q.trim()) return;
    navigate(`/ats/search?q=${encodeURIComponent(q)}`);
  }

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
            Dashboard
          </div>
          {groups.map(([s, label, items]) => (
            <div className={'sb-group' + (isGroupOpen(s) ? ' open' : '')} key={s}>
              <div className="sb-group-head" onClick={() => toggleGroup(s, items)}>
                <span>{label}</span><span className="chev">▸</span>
              </div>
              <div className="sb-sub">
                {items.map((item) => (item.children ? (
                  <div className={'sb-sub-group' + (isSubOpen(item.id) ? ' open' : '')} key={item.id}>
                    <div className="sb-sub-head" onClick={() => toggleSub(item.id)}>
                      <span>{item.label}</span><span className="chev">▸</span>
                    </div>
                    <div className="sb-leaf-list">
                      {item.children.map((c) => (
                        <div
                          key={c.to}
                          className={'sb-leaf' + (isActive(c.to) ? ' active' : '')}
                          onClick={() => navTo(c.to)}
                        >
                          {c.label}
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
                    {item.label}
                  </div>
                )))}
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
          <div className="topbar-title">{sectionLabel(section, user)}</div>
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
              <Combo
                className="rolechip"
                aria-label="Workspace"
                value={user.workspace}
                onChange={(e) => switchWorkspace(e.target.value).then((u) => navTo(u.landingPath))}
                style={{ padding: '2px 6px' }}
              >
                {user.workspaces.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
              </Combo>
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
              {current && pathname !== currentPath && (
                <>
                  <span className="bc-sep">/</span>
                  <span className="bc-current">
                    {decodeURIComponent(pathname.slice(currentPath.length + 1))}
                  </span>
                </>
              )}
            </>
          )}
        </div>

        <main>
          {/* FIRST LOGIN. Whatever workspace this person lands in, if their
              employee profile still needs them, they are told here. It
              renders nothing once the profile is with HR or approved, and
              nothing on the profile form itself — that page says it in
              place, and saying it twice on one screen reads as a bug. */}
          {pathname !== '/my-profile' && <ProfileStatusBanner variant="shell" />}
          {/* An external login that types the URL of an internal screen gets a
              plain refusal rather than the screen's chrome — see
              mayRenderSection() in ../nav.js for why. */}
          {mayRenderSection(user, pathname) ? <Outlet /> : (
            <div className="card">
              <h1>Not available</h1>
              <div className="page-sub">This area is not part of your access.</div>
            </div>
          )}
        </main>

        <footer>
          {/* No product names: this footer renders for clients and candidates too. */}
          TeamLink.Enterprise · connected to the TeamLink Job Portal
        </footer>
      </div>

      {/* Floating, role-aware assistant (bottom right). */}
      <AiAssistant />
    </div>
  );
}
