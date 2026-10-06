import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { INTERVIEW_TABS, INTERVIEW_PATHS, visibleItems } from '../nav';

// Tabs of ATS → Interview Calendar: Interviews · Feedback · Offers · Joining
// (user, 2026-10-03: "side bar lo extra modules add cheyyodhu" — fold the
// workflow screens into the existing module). Shown only on those four pages;
// each tab follows its page's own view permission (nav.js INTERVIEW_TABS).
// Same pattern as components/SetupTabs.jsx.
export default function InterviewTabs({ pathname }) {
  const { user } = useAuth() || {};
  if (!INTERVIEW_PATHS.includes(pathname)) return null;
  const tabs = visibleItems(user, INTERVIEW_TABS);
  if (tabs.length < 2) return null;
  return (
    <div className="tabs" role="tablist" aria-label="Interview Calendar" style={{ marginBottom: 14 }}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end role="tab" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
