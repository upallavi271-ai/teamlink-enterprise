import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import sharedGet from '../../utils/sharedGet';

// ---------------------------------------------------------------------------
// THE ADMIN HEALTH DOT (dashboard review #2): integration / sync / job-
// posting errors are not business numbers, so they leave the dashboard and
// become one small dot in the top bar — only for the people allowed to see
// system alerts (GET /api/dashboard/ats/health), and only when something is
// actually wrong.
// ---------------------------------------------------------------------------
export default function HealthDot() {
  const { pathname } = useLocation();
  const [h, setH] = useState(null);
  useEffect(() => {
    let alive = true;
    sharedGet('/dashboard/ats/health').then((r) => { if (alive) setH(r.data); }).catch(() => { if (alive) setH(null); });
    return () => { alive = false; };
  }, [pathname]);
  if (!h || !h.show || !h.problems) return null;
  const title = `${h.problems} system problem${h.problems === 1 ? '' : 's'}: ${h.rows.map((r) => r.what).join(' · ')}`;
  return (
    <Link to={h.to} className="rolechip" title={title} aria-label={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
      <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--red, #c62828)', display: 'inline-block' }} />
      {h.problems}
    </Link>
  );
}
