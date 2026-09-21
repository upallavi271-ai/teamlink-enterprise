import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isClientUser } from '../../permissions';
import { JOB_PORTAL_URL } from '../JobPortalRedirect.jsx';

// The prototype's atsDashboard() (line 6252): a six-tile statbar, then a
// two-column split with "Pipeline by stage" on the left and "Recruiter
// workload" + "Job Portal Integration" stacked on the right.
//
// The prototype lists the pipeline stages in ATS_STAGES order and then
// "Hold, Rejected"; its candidate filter uses the opposite order. The backend
// already returns them in the dashboard's own order, which is what is used here.
export default function AtsDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [synced, setSynced] = useState(null);

  function load() {
    api.get('/dashboard').then((res) => setData(res.data));
    api.get('/candidates')
      .then((res) => setSynced(res.data.filter((c) => ['Job Portal', 'TeamLink Website'].includes(c.source)).length))
      .catch(() => setSynced(null));
  }
  useEffect(load, []);

  if (!data) return <div className="small-muted">Loading…</div>;

  const isClient = isClientUser(user);
  const stats = [
    [data.openRequirements, 'Open requirements'],
    [data.recruiterReview, 'Recruiter review'],
    [data.withBde, 'With BDE'],
    [data.clientReview, 'Client review'],
    [data.interviewsUpcoming, 'Interviews upcoming'],
    [data.hiringOutcomes, 'Hiring outcomes this cycle'],
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>ATS Dashboard</h1>
          <div className="page-sub">Recruitment pipeline overview</div>
        </div>
      </div>

      <div className="statbar">
        {stats.map(([n, l]) => (
          <div className="statitem" key={l}>
            <div className="n">{n ?? 0}</div>
            <div className="l">{l}</div>
          </div>
        ))}
      </div>

      <div className="two-col">
        <div className="card section">
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Pipeline by stage</h3>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Stage</th><th>Candidates</th></tr></thead>
              <tbody>
                {(data.pipelineByStage || []).map((s) => (
                  <tr
                    key={s.stage}
                    className="row-link"
                    onClick={() => navigate(`/candidates?stage=${encodeURIComponent(s.stage)}`)}
                  >
                    <td>{s.label}</td>
                    <td>{s.count}</td>
                  </tr>
                ))}
                {(data.pipelineByStage || []).length === 0 && (
                  <tr><td colSpan="2" className="small-muted" style={{ padding: 16 }}>No candidates in the pipeline yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="card section">
            <h3 style={{ fontSize: 13, marginBottom: 10 }}>Recruiter workload</h3>
            {(data.recruiterWorkload || []).map((r) => (
              <div className="kv" key={r.name}>
                <span className="k">{r.name}</span>
                <span>{r.requirements} requirements</span>
              </div>
            ))}
            {(data.recruiterWorkload || []).length === 0 && (
              <div className="small-muted">No recruiters on file.</div>
            )}
          </div>

          {!isClient && (
            <div className="card">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Job Portal Integration</h3>
              <div className="kv">
                <span className="k">Connection</span>
                <span><span className="conn-dot ok" />Connected</span>
              </div>
              <div className="kv">
                <span className="k">Portal</span>
                <span>TeamLink Job Portal — served at /job-portal/</span>
              </div>
              <div className="kv">
                <span className="k">Candidates from portal sources</span>
                <span>{synced ?? '—'}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {/* Sync ≠ Open Job Portal. Sync stays on this page and only
                    re-reads this ATS; Open Job Portal opens the portal itself. */}
                <button className="btn btn-sm btn-primary" onClick={load}>Sync</button>
                <a className="btn btn-sm" href={JOB_PORTAL_URL} target="_blank" rel="noreferrer">Open Job Portal ↗</a>
              </div>
              <div className="small-muted" style={{ marginTop: 8 }}>
                <strong>Sync</strong> re-reads this ATS and refreshes the count above. It does not yet
                exchange records with the Job Portal app — that portal keeps its own data in the
                browser. See Administration → Integrations for what a two-way sync still needs.
              </div>
              <span
                className="link-btn"
                style={{ display: 'block', marginTop: 8, cursor: 'pointer' }}
                onClick={() => navigate('/admin/integrations')}
              >
                Full integration details →
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
