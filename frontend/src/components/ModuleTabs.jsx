import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { CLIENTS_REQ_TABS, REPORTS_TEAM_TABS, moduleTabsFor } from '../nav';
import TabStrip from './ui/TabStrip.jsx';

// Tabs of the two ATS v3 modules (user, 2026-10-03 — five sidebar entries,
// no more):
//   Clients & Requirements   Clients | Requirements | Agreements   on /clients, /requirements, /agreements
//   Reports & Team           Reports | Team | Call lists | More (Handover, Data quality)
//                            on /reports/ats (or /reports/my-results), /ats/team, /ats/followups ...
// Drawn above the page by Shell.jsx; each tab follows its page's own view
// permission (nav.js). One tab or none -> no bar.
// 2026-11-20 (founder: "give clear tabs"): the one TabStrip — at most five on screen, the rarely used ones under
// More, a tooltip on every tab and one line under the strip saying what the open tab is for. Each tab is still a link
// (its own address), so old links and bookmarks keep working.
const SAY = {
  '/clients': 'The companies we hire for: contacts, agreement, requirements and how each one is doing.',
  '/requirements': 'The jobs we are filling: who works on each one, and how many people are at each step.',
  '/agreements': 'Client agreements: drafts, sent, signed, and the ones that need renewing.',
  '/ats/contract-staff': 'Placed contractors and temp staff: timesheets, shifts, pay and bill, billing files and the VMS of the client.',
  '/reports/ats': 'Numbers for hiring: requirements, candidates, interviews, joinings and money.',
  '/reports/my-results': 'Your own numbers: what you sent, interviews, selections and joinings.',
  '/ats/team': 'The team: who has how much work, assignments, tasks and follow-ups.',
  '/ats/handover': 'Hand a leaving or moving recruiter\'s candidates and requirements to someone else.',
  '/ats/call-lists': 'Sheets of contacts split among recruiters, who call their own block.',
  '/ats/data-quality': 'Profiles that need fixing: missing details, duplicates and old profiles.',
};
// Under "More" (rarely opened).
const MORE = ['/ats/handover', '/ats/data-quality'];
const BARS = [
  { label: 'Clients & Requirements', tabs: CLIENTS_REQ_TABS, on: ['/clients', '/requirements', '/agreements', '/ats/contract-staff'] },
  {
    label: 'Reports & Team',
    tabs: REPORTS_TEAM_TABS,
    on: ['/reports/ats', '/reports/my-results', '/reports/job-portal', '/ats/team', '/ats/followups', '/ats/settings', '/ats/handover', '/ats/call-lists', '/ats/data-quality'],
    // Follow-ups is a view of the Team tab; Job Portal Reports a tab of ATS Reports.
    alias: { '/ats/followups': '/ats/team', '/reports/job-portal': '/reports/ats' },
  },
];

// The tab says "Requirements" (user, 2026-10-17: Job -> Requirement again).

export default function ModuleTabs({ pathname }) {
  const { user } = useAuth() || {};
  const navigate = useNavigate();
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
    <div className="module-tabs" style={{ marginBottom: 14 }}>
      <TabStrip
        label={bar.label}
        value={here}
        onChange={(to) => navigate(to)}
        maxMain={5}
        tabs={tabs.map((t) => ({ key: t.to, label: t.label, hint: SAY[t.to] || t.label, more: tabs.length > 3 && MORE.includes(t.to) }))}
      />
    </div>
  );
}
