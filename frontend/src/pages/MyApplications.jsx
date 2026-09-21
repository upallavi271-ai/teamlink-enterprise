import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { stageLabel } from '../atsVocab';

// Candidate portal — someone who applied through /careers checks where their
// applications got to, using the email they applied with. No account, matching
// the no-login apply flow in JobDetail.jsx.
export default function MyApplications() {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function check(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.get('/public/my-applications', { params: { email } });
      setResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not look that up right now');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="careers-shell">
      <header className="careers-header">
        <div className="logo-lockup">
          <div className="mark">TL</div>
          <div>
            <div style={{ fontWeight: 600 }}>TeamLink Consultants</div>
            <div className="small-muted">My Applications</div>
          </div>
        </div>
      </header>
      <main className="careers-content">
        <Link className="small-muted" to="/careers/classic">← Back to open positions</Link>
        <h1 style={{ marginTop: 10 }}>Check your application status</h1>
        <p className="small-muted">Enter the email address you applied with — no account needed.</p>
        <form className="filter-row" onSubmit={check} style={{ maxWidth: 460 }}>
          <input
            style={{ flex: 1 }}
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Check status'}
          </button>
        </form>

        {error && <div className="error-text">{error}</div>}

        {result && (
          <div className="card section">
            {result.name && <h3>Applications for {result.name}</h3>}
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Role</th><th>Company</th><th>Status</th><th>Last update</th></tr></thead>
                <tbody>
                  {result.applications.map((a) => (
                    <tr key={a.id}>
                      <td>{a.jobTitle}</td>
                      <td>{a.client}{a.location ? ` · ${a.location}` : ''}</td>
                      <td><span className="status">{stageLabel(a.stage)}</span></td>
                      <td>{new Date(a.updatedAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                  {result.applications.length === 0 && (
                    <tr><td colSpan="4" className="small-muted">No applications found for that email.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
