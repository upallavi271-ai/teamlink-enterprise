import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { CLIENTS_REQ_TABS, REPORTS_TEAM_TABS, moduleTabsFor } from '../nav';

// Tabs of the two ATS v3 modules (user, 2026-10-03 — five sidebar entries,
// no more):
//   Clients & Requirements   Clients | Requirements          on /clients, /requirements
//   Reports & Team           Reports | Team | Settings        on /reports/ats (or
//                            /reports/my-results), /ats/team, /ats/followups, /ats/settings
// Drawn above the page by Shell.jsx; each tab follows its page's own view
// permission (nav.js). One tab or none -> no bar. Same look as InterviewTabs.
const BARS = [
  { label: 'Clients & Requirements', tabs: CLIENTS_REQ_TABS, on: ['/clients', '/requirements', '/agreements'] },
  {
    label: 'Reports & Team',
    tabs: REPORTS_TEAM_TABS,
    on: ['/reports/ats', '/reports/my-results', '/reports/job-portal', '/ats/team', '/ats/followups', '/ats/settings'],
    // Follow-ups is a view of the Team tab; Job Portal Reports a tab of ATS Reports.
    alias: { '/ats/followups': '/ats/team', '/reports/job-portal': '/reports/ats' },
  },
];

// Plain words on the tab (user, 2026-10-05: "Job, not Requirement"); the
// nav.js labels and routes stay as they are.
const PLAIN_TAB = { Requirements: 'Jobs' };

export default function ModuleTabs({ pathname }) {
  const { user } = useAuth() || {};
  const bar = BARS.find((b) => b.on.includes(pathname));
  if (!bar) return null;
  const tabs = moduleTabsFor(user, bar.tabs);
  if (tabs.length < 2) return null;
  let here = (bar.alias && bar.alias[pathname]) || pathname;
  // A report page this login reaches under another tab (My Results opened by
  // a login whose tab is "Reports"): light the report tab.
  if (!tabs.some((t) => t.to === here) && here.startsWith('/reports/')) {
    const rep = tabs.find((t) => t.to.startsWith('/reports/'));
    if (rep) here = rep.to;
  }
  return (
    <div className="tabs" role="tablist" aria-label={bar.label} style={{ marginBottom: 14 }}>
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end
          role="tab"
          aria-selected={here === t.to}
          className={() => `tab${here === t.to ? ' active' : ''}`}
        >
          {PLAIN_TAB[t.label] || t.label}
        </NavLink>
      ))}
    </div>
  );
}
