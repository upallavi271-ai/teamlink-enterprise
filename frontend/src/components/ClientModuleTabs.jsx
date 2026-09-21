import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { canModule, canSeePortalWorkspace, canSeeClientPortal } from '../permissions';

// ---------------------------------------------------------------------------
// Clients and Requirements used to be two top-level screens. They are ONE
// module now, with four tabs:
//
//     Clients · Requirements · Agreements · Job Portal
//
// The tab bar lives here so all four screens show the identical strip and a
// click moves between real routes (each tab is bookmarkable and each still
// answers on its own URL, which is what the nav links to).
//
// The ATS sidebar is flat again, matching the reference prototype, so this
// strip is what keeps Agreements reachable — it is not listed in the nav.
// ---------------------------------------------------------------------------
// The PUBLIC portal's own URL — a separate document, not a route in this SPA.
// The "Job Portal" TAB no longer points here: the tab is the internal
// workspace, and opening the public portal is a distinct, clearly-labelled
// action (see JobPortalWorkspace.jsx). They were conflated before, which made
// one link look like two different things.
export const JOB_PORTAL_PATH = '/job-portal/';

const TABS = [
  { key: 'clients', label: 'Clients', to: '/clients', module: 'clients' },
  { key: 'requirements', label: 'Requirements', to: '/requirements', module: 'requirements' },
  { key: 'agreements', label: 'Agreements', to: '/agreements', module: 'clients' },
];

// Which Job Portal tab this user gets — and whether they get one at all — is
// the permission matrix's answer, not a role test. Staff with the workspace
// feature go to the internal workspace; a client goes to the client-facing
// view; anyone holding neither sees no tab.
function portalTab(user) {
  if (canSeePortalWorkspace(user)) {
    return { key: 'jobportal', label: 'Job Portal', to: '/requirements/job-portal' };
  }
  if (canSeeClientPortal(user)) {
    return { key: 'jobportal', label: 'Job Portal', to: '/client-portal' };
  }
  return null;
}

export default function ClientModuleTabs({ active }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const tabs = [...TABS.filter((t) => canModule(user, t.module)), portalTab(user)].filter(Boolean);
  // Longest match first, so /requirements/job-portal beats /requirements.
  const byLength = [...tabs].sort((a, b) => b.to.length - a.to.length);
  const current = active || byLength.find((t) => pathname.startsWith(t.to))?.key || 'clients';

  return (
    <div className="tabs" style={{ marginBottom: 16 }}>
      {tabs.map((t) => (
        <Link
          key={t.key}
          to={t.to}
          className={`tab${current === t.key ? ' active' : ''}`}
          style={{ textDecoration: 'none' }}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
