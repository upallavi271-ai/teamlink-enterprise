import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';

// ---------------------------------------------------------------------------
// "🔴 DO THIS NOW" (§27).
//
// The top of every role's dashboard. At most five things, overdue first, each
// with ONE button — the point is that a user should never have to go looking
// for their own work, or work out which of it is late.
//
// It renders NOTHING when there is nothing overdue or due today. An empty
// panel that says "nothing to do" every day teaches people to skip the top of
// the page, which is exactly the habit this is meant to break.
// ---------------------------------------------------------------------------
export default function DoThisNow() {
  const [items, setItems] = useState(null);

  useEffect(() => {
    api.get('/followups/dashboard')
      .then((r) => setItems(r.data.doThisNow || []))
      .catch(() => setItems([]));
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <div className="card section do-now">
      <div className="panel-head">
        <h3>🔴 Do This Now</h3>
        <Link className="link-btn" to="/ats/followups">All follow-ups →</Link>
      </div>
      <ol className="do-now-list">
        {items.map((d) => (
          <li key={d.applicationId}>
            <span className="do-now-what">
              <b>{d.what}</b>
              <span className="small-muted"> — {d.why}</span>
            </span>
            <span className={`fu-chip ${d.status === 'Overdue' ? 'fu-overdue' : 'fu-due'}`}>
              {d.status === 'Overdue' ? '🔴' : '🟠'} {d.status}{d.due ? ` · ${d.due}` : ''}
            </span>
            <Link className="btn btn-sm btn-primary" to={`/candidates/${d.candidateId}`}>Contact</Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
