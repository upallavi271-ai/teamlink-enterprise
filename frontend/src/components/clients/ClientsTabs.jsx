import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import './clientsrole.css';

// ---------------------------------------------------------------------------
// THE CLIENTS MODULE'S OWN STRIP (clients role spec 2026-09-29):
//
//   Clients | Agreements
//
// Clients is ONE place — ATS → Clients — and Agreements are client-level, so
// they sit beside it here rather than on a Requirements / Job Portal strip
// (components/ClientModuleTabs.jsx is retired from these pages). Agreements
// is drawn only for a login with Agreement Lifecycle view (Admin, Management,
// BDE, Accounts — not a TL). A login without the Clients list (a Recruiter,
// or an Accounts login reaching /accounts/agreements without ATS) gets no
// strip at all.
// ---------------------------------------------------------------------------
export default function ClientsTabs({ active }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  if (!can(user, 'ats', 'clients', 'Client List', 'view')) return null;
  const tabs = [
    { key: 'clients', label: 'Clients', to: '/clients', hint: 'Every client in your scope — one record per client' },
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'view')
      && { key: 'agreements', label: 'Agreements', to: '/agreements', hint: 'The service agreement of every client in your scope' },
  ].filter(Boolean);
  if (tabs.length < 2) return null;
  const current = active || (pathname.includes('agreements') ? 'agreements' : 'clients');
  return (
    <div className="clrole-switch">
      <div className="tabs" style={{ marginBottom: 0 }} role="tablist" aria-label="Clients module">
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
