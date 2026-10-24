import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './agreementFlow.css';

// "Agreements waiting for you" - a small card on the dashboard (user, 2026-10-13). Shown only to a login that
// has a part in the agreement steps AND something waiting; everyone else gets a 403 and sees nothing.
export default function AgreementsWaiting() {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/agreement-flow/waiting').then((r) => { if (alive) setD(r.data); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!d || !d.count) return null;
  return (
    <div className="af" role="region" aria-label="Agreements waiting for you">
      <b>Agreements waiting for you: {d.count}</b>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {d.rows.slice(0, 5).map((r) => (
          <li key={r.id}><Link to={r.stage === 'WITH_HR' ? `/tax-billing/${r.id}` : `/clients/${r.id}?tab=agreement`}>{r.name}</Link> <span className="small-muted">· {r.todo}</span></li>
        ))}
      </ul>
      <div style={{ marginTop: 8 }}><Link className="btn btn-primary btn-sm" to="/tax-billing">See all</Link></div>
    </div>
  );
}
