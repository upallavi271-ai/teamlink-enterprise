import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { can, canSeeClientPortal } from '../permissions';
import './jobs/jobs.css';

// ---------------------------------------------------------------------------
// THE JOBS WORKSPACE STRIP (ATS review #3 §4):
//
//   Requirements | Clients | Agreements | Job Portal
//
// One flat row, role-aware — each tab is drawn only for a login that may open
// it (hide, don't disable):
//   Requirements  the requirements module
//   Clients       the client desk only (SA / Admin / Manager / Asst Manager /
//                 BDE — clients/Client List/view). Everyone else works with
//                 the client's NAME on the requirement and never gets a tab.
//   Agreements    the client desk too (it is every client's agreement)
//   Job Portal    the portal workspace, or a client login's own portal
//
// Routes: /requirements, /clients, /agreements (+ /ats/agreements),
// /requirements/job-portal, /client-portal.
// ---------------------------------------------------------------------------
// The PUBLIC portal's own URL — a separate document, not a route in this SPA.
export const JOB_PORTAL_PATH = '/job-portal/';

// Which Job Portal entry this user gets — and whether they get one at all — is
// the permission matrix's answer, not a role test.
function portalItem(user) {
  // The internal Job Portal is candidate intake now (Candidates & Pipeline → Job Portal Candidates), not a tab here.
  if (canSeeClientPortal(user)) return { key: 'jobportal', label: 'Job Portal', to: '/client-portal', hint: 'Your openings on the job portal' };
  return null;
}

// ROLE SPECS 2026-09-29: Jobs / Requirements has NO tab strip any more and
// Clients is its own ATS menu entry. What is left here is the Clients
// module's own pair — Clients | Agreements — for a page that still renders
// this component. Agreements is sensitive (fee %, guarantee, terms): only a
// login holding Agreement Lifecycle view (Admin, Mgmt, BDE, Accounts) gets
// the tab; a TL does not, and a Recruiter has no Clients module at all.
export function jobsTabs(user) {
  const desk = can(user, null, 'clients', 'Client List', 'view');
  const agreements = can(user, null, 'clients', 'Agreement Lifecycle', 'view');
  return [
    desk && { key: 'clients', label: 'Clients', to: '/clients', hint: 'One record per client' },
    desk && agreements && { key: 'agreements', label: 'Agreements', to: '/agreements', hint: 'Agreement pipeline across your clients' },
    portalItem(user),
  ].filter(Boolean);
}

export default function ClientModuleTabs({ active }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const tabs = jobsTabs(user);
  if (tabs.length < 2 && !tabs.some((t) => t.key === 'jobportal')) return null;

  const current = active
    || (pathname.startsWith('/requirements/job-portal') || pathname.startsWith('/client-portal') ? 'jobportal'
      : pathname.includes('agreements') ? 'agreements'
        : pathname.startsWith('/clients') ? 'clients' : 'requirements');

  return (
    <div className="jobsws-switch">
      <div className="tabs" style={{ marginBottom: 0 }} role="tablist" aria-label="Jobs workspace">
        {tabs.map((t) => (
          <Link
            key={t.key}
            to={t.to}
            role="tab"
            aria-selected={current === t.key}
            title={t.hint}
            className={`tab${current === t.key ? ' active' : ''}`}
            style={{ textDecoration: 'none' }}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
