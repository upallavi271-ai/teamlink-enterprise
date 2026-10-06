import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { SETUP_TABS, SETUP_PATHS, visibleItems } from '../nav';

// Tabs of Administration → Company Setup. The settings pages added on
// 2026-10-03 (Master lists, Step timing, Fit settings, Backups & safety) live
// here instead of as sidebar entries (user: "side bar lo extra modules add
// cheyyodhu"). Shown only on those pages; each tab follows the same access
// rule its page has (nav.js SETUP_TABS).
export default function SetupTabs({ pathname }) {
  const { user } = useAuth() || {};
  if (!SETUP_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  const tabs = visibleItems(user, SETUP_TABS);
  if (tabs.length < 2) return null;
  return (
    <div className="tabs" role="tablist" aria-label="Company Setup" style={{ marginBottom: 14 }}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} role="tab" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
