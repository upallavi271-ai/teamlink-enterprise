import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import './ViewAs.css';

// Administration -> Users (Super Admin only): who acted as whom, when, and how
// many changes were made. Built from the audit log (backend utils/actAs.js
// history()); nothing here can change anything.
const fmt = (d) => (d ? new Date(d).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function ActAsHistory() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const allowed = !!(user && user.role === 'SUPER_ADMIN' && !user.viewAs);

  useEffect(() => {
    if (!allowed) return;
    api.get('/admin/view-as/act-history')
      .then((res) => setRows(res.data.sessions || []))
      .catch((err) => setError(err?.response?.data?.error || 'Could not load the Acted as list.'));
  }, [allowed]);

  if (!allowed) return null;
  return (
    <div className="card tl-actas-hist">
      <h3>Acted as — history</h3>
      <div className="tl-ah-sub">Every time a Super Admin used the app as another person with real changes (last 90 days).</div>
      {error && <div className="error-text">{error}</div>}
      {!rows && !error && <div className="page-sub">Loading…</div>}
      {rows && !rows.length && <div className="page-sub">Nobody has acted as anyone yet. Use Administration → View as → Act as (edit).</div>}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr><th>Who</th><th>Acted as</th><th>Started</th><th>Ended</th><th>Changes</th></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.sid}>
                <td data-l="Who">{s.byName}</td>
                <td data-l="Acted as">{s.targetName || '—'}</td>
                <td data-l="Started">{fmt(s.startedAt)}</td>
                <td data-l="Ended">{s.live ? <span className="tl-ah-live">Acting now</span> : `${fmt(s.endedAt)} · ${s.endedHow}`}</td>
                <td data-l="Changes">{s.changes}{s.refused ? ` (+${s.refused} refused)` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
