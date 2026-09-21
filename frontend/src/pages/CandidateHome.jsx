import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { stageLabel } from '../atsVocab';

// ---------------------------------------------------------------------------
// Where a signed-in CANDIDATE lands.
//
// identity.js sends them to /my-applications, but the only page answering
// anything like that name was pages/MyApplications.jsx — the PUBLIC, no-login
// lookup that asks for the email you applied with, mounted at
// /careers/my-applications. So a candidate who signed in hit a dead route,
// and reaching the public page would have asked them to type an address the
// app already knows.
//
// This is the authenticated view: no email prompt, no lookup. /applications
// and /candidates are already scoped to the signed-in candidate by
// utils/scope.js — each returns exactly their own row — so there is nothing to
// filter here and nothing a candidate could widen by editing the request.
// ---------------------------------------------------------------------------
export default function CandidateHome() {
  const { user } = useAuth();
  const [apps, setApps] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/applications')
      .then((res) => setApps(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load your applications'));
  }, []);

  if (error) return <div className="error-text">{error}</div>;
  if (!apps) return <div className="small-muted">Loading…</div>;

  const interviews = apps.filter((a) => a.interviewAt);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>My Applications</h1>
          <div className="page-sub">
            {user?.name ? `${user.name} · ` : ''}
            {apps.length} application{apps.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="statbar" style={{ marginBottom: 16 }}>
        <div className="statitem"><div className="n">{apps.length}</div><div className="l">Applications</div></div>
        <div className="statitem"><div className="n">{interviews.length}</div><div className="l">Interviews scheduled</div></div>
      </div>

      <div className="card section">
        <h3>Where each application stands</h3>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Role</th><th>Company</th><th>Stage</th><th>Interview</th><th>Applied</th></tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id}>
                  <td>{a.requirement?.title || '—'}</td>
                  <td>{a.requirement?.client?.name || '—'}</td>
                  <td><span className="status">{stageLabel(a.stage)}</span></td>
                  <td>
                    {a.interviewAt
                      ? new Date(a.interviewAt).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                      })
                      : <span className="cell-muted">—</span>}
                  </td>
                  <td>
                    {a.createdAt
                      ? new Date(a.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                      : '—'}
                  </td>
                </tr>
              ))}
              {apps.length === 0 && (
                <tr><td colSpan="5" className="small-muted">You have no applications yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
