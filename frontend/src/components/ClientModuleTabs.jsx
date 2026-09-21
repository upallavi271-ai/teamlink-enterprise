import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { canModule } from '../permissions';

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
// JOB PORTAL is another agent's screen this round. The tab is wired to
// /job-portal, the in-app route they are adding; until that route exists the
// link falls back to the public portal at /careers, which is the same content
// without the internal chrome. When their route lands, delete the fallback and
// leave the first entry — nothing else here has to change.
// ---------------------------------------------------------------------------
export const JOB_PORTAL_PATH = '/careers';

const TABS = [
  { key: 'clients', label: 'Clients', to: '/clients', module: 'clients' },
  { key: 'requirements', label: 'Requirements', to: '/requirements', module: 'requirements' },
  { key: 'agreements', label: 'Agreements', to: '/agreements', module: 'clients' },
  { key: 'jobportal', label: 'Job Portal', to: JOB_PORTAL_PATH, module: 'requirements' },
];

export default function ClientModuleTabs({ active }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const current = active || TABS.find((t) => pathname.startsWith(t.to))?.key || 'clients';

  return (
    <div className="tabs" style={{ marginBottom: 16 }}>
      {TABS.filter((t) => canModule(user, t.module)).map((t) => (
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
